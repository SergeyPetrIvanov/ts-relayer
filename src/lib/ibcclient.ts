import { toAscii } from '@cosmjs/encoding';
import { Coin, coins, logs } from '@cosmjs/launchpad';
import { OfflineSigner, Registry } from '@cosmjs/proto-signing';
import {
  AuthExtension,
  BankExtension,
  BroadcastTxFailure,
  BroadcastTxResponse,
  defaultRegistryTypes,
  isBroadcastTxFailure,
  parseRawLog,
  QueryClient,
  setupAuthExtension,
  setupBankExtension,
  SigningStargateClient,
  SigningStargateClientOptions,
} from '@cosmjs/stargate';
// import { firstEvent } from '@cosmjs/stream';
import {
  adaptor34,
  CommitResponse,
  ReadonlyDateWithNanoseconds,
  Header as RpcHeader,
  ValidatorPubkey as RpcPubKey,
  Client as TendermintClient,
} from '@cosmjs/tendermint-rpc';
import { arrayContentEquals, sleep } from '@cosmjs/utils';
import Long from 'long';

import { HashOp, LengthOp } from '../codec/confio/proofs';
import { Any } from '../codec/google/protobuf/any';
import { Timestamp } from '../codec/google/protobuf/timestamp';
import { Order, State } from '../codec/ibc/core/channel/v1/channel';
import {
  MsgChannelOpenAck,
  MsgChannelOpenConfirm,
  MsgChannelOpenInit,
  MsgChannelOpenTry,
} from '../codec/ibc/core/channel/v1/tx';
import { Height } from '../codec/ibc/core/client/v1/client';
import {
  MsgCreateClient,
  MsgUpdateClient,
} from '../codec/ibc/core/client/v1/tx';
import { Version } from '../codec/ibc/core/connection/v1/connection';
import {
  MsgConnectionOpenAck,
  MsgConnectionOpenConfirm,
  MsgConnectionOpenInit,
  MsgConnectionOpenTry,
} from '../codec/ibc/core/connection/v1/tx';
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
  Header as TendermintHeader,
} from '../codec/ibc/lightclients/tendermint/v1/tendermint';
import { PublicKey as ProtoPubKey } from '../codec/tendermint/crypto/keys';
import {
  blockIDFlagFromJSON,
  Commit,
  Header,
  SignedHeader,
} from '../codec/tendermint/types/types';
import { ValidatorSet } from '../codec/tendermint/types/validator';

import { IbcExtension, setupIbcExtension } from './queries/ibc';

/**** These are needed to bootstrap the endpoints */
/* Some of them are hardcoded various places, which should we make configurable? */
// const DefaultTrustLevel = '1/3';
// const MaxClockDrift = 10; // 10 seconds
// const upgradePath = ['upgrade', 'upgradedIBCState'];
// const allowUpgradeAfterExpiry = false;
// const allowUpgradeAfterMisbehavior = false;

// these are from the cosmos sdk implementation
const defaultMerklePrefix = {
  keyPrefix: toAscii('ibc'),
};
const defaultConnectionVersion: Version = {
  identifier: '1',
  features: ['ORDER_ORDERED', 'ORDER_UNORDERED'],
};
// this is a sane default, but we can revisit it
const defaultDelayPeriod = new Long(0);

function ibcRegistry(): Registry {
  return new Registry([
    ...defaultRegistryTypes,
    ['/ibc.core.client.v1.MsgCreateClient', MsgCreateClient],
    ['/ibc.core.client.v1.MsgUpdateClient', MsgUpdateClient],
    ['/ibc.core.connection.v1.MsgConnectionOpenInit', MsgConnectionOpenInit],
    ['/ibc.core.connection.v1.MsgConnectionOpenTry', MsgConnectionOpenTry],
    ['/ibc.core.connection.v1.MsgConnectionOpenAck', MsgConnectionOpenAck],
    [
      '/ibc.core.connection.v1.MsgConnectionOpenConfirm',
      MsgConnectionOpenConfirm,
    ],
    ['/ibc.core.channel.v1.MsgChannelOpenInit', MsgChannelOpenInit],
    ['/ibc.core.channel.v1.MsgChannelOpenTry', MsgChannelOpenTry],
    ['/ibc.core.channel.v1.MsgChannelOpenAck', MsgChannelOpenAck],
    ['/ibc.core.channel.v1.MsgChannelOpenConfirm', MsgChannelOpenConfirm],
  ]);
}

function timestampFromDateNanos(date: ReadonlyDateWithNanoseconds): Timestamp {
  const nanos = (date.getTime() % 1000) * 1000000 + (date.nanoseconds ?? 0);
  return Timestamp.fromPartial({
    seconds: new Long(date.getTime() / 1000),
    nanos,
  });
}

export function toIntHeight(height?: Height): number {
  return height?.revisionHeight?.toNumber() ?? 0;
}

export function toProtoHeight(height: number): Height {
  return Height.fromPartial({
    revisionHeight: new Long(height),
  });
}

/// This is the default message result with no extra data
export interface MsgResult {
  readonly logs: readonly logs.Log[];
  /** Transaction hash (might be used as transaction ID). Guaranteed to be non-empty upper-case hex */
  readonly transactionHash: string;
}

export type CreateClientResult = MsgResult & {
  readonly clientId: string;
};

export type CreateConnectionResult = MsgResult & {
  readonly connectionId: string;
};

export type CreateChannelResult = MsgResult & {
  readonly channelId: string;
};

interface ConnectionHandshakeProof {
  clientId: string;
  connectionId: string;
  clientState?: Any;
  proofHeight: Height;
  // proof of the state of the connection on remote chain
  proofConnection: Uint8Array;
  // proof of client state included in message
  proofClient: Uint8Array;
  // proof of client consensus state
  proofConsensus: Uint8Array;
  // last header height of this chain known by the remote chain
  consensusHeight?: Height;
}

export interface ChannelHandshake {
  id: ChannelInfo;
  proofHeight: Height;
  // proof of the state of the channel on remote chain
  proof: Uint8Array;
}

export interface ChannelInfo {
  readonly portId: string;
  readonly channelId: string;
}

function createBroadcastTxErrorMessage(result: BroadcastTxFailure): string {
  return `Error when broadcasting tx ${result.transactionHash} at height ${result.height}. Code: ${result.code}; Raw log: ${result.rawLog}`;
}

// TODO: replace this with buildFees in IbcClient constructor to take custom gasPrice, override gas needed
const fees = {
  initClient: {
    amount: coins(2500, 'ucosm'),
    gas: '100000',
  },
  updateClient: {
    amount: coins(10000, 'ucosm'),
    gas: '400000',
  },
  initConnection: {
    amount: coins(2500, 'ucosm'),
    gas: '100000',
  },
  connectionHandshake: {
    amount: coins(5000, 'ucosm'),
    gas: '200000',
  },
  initChannel: {
    amount: coins(2500, 'ucosm'),
    gas: '100000',
  },
  channelHandshake: {
    amount: coins(5000, 'ucosm'),
    gas: '200000',
  },
};

export class IbcClient {
  public readonly sign: SigningStargateClient;
  public readonly query: QueryClient &
    AuthExtension &
    BankExtension &
    IbcExtension;
  public readonly tm: TendermintClient;
  public readonly senderAddress: string;

  public static async connectWithSigner(
    endpoint: string,
    signer: OfflineSigner,
    senderAddress: string,
    options?: SigningStargateClientOptions
  ): Promise<IbcClient> {
    // override any registry setup, use the other options
    const registryOptions = { ...options, registry: ibcRegistry() };
    const signingClient = await SigningStargateClient.connectWithSigner(
      endpoint,
      signer,
      registryOptions
    );
    const tmClient = await TendermintClient.connect(endpoint, adaptor34);
    return new IbcClient(signingClient, tmClient, senderAddress);
  }

  private constructor(
    signingClient: SigningStargateClient,
    tmClient: TendermintClient,
    senderAddress: string
  ) {
    this.sign = signingClient;
    this.tm = tmClient;
    this.query = QueryClient.withExtensions(
      tmClient,
      setupAuthExtension,
      setupBankExtension,
      setupIbcExtension
    );
    this.senderAddress = senderAddress;
  }

  public getChainId(): Promise<string> {
    return this.sign.getChainId();
  }

  public async latestHeader(): Promise<RpcHeader> {
    // TODO: expose header method on tmClient and use that
    const block = await this.tm.block();
    return block.block.header;
  }

  public async header(height: number): Promise<RpcHeader> {
    // TODO: expose header method on tmClient and use that
    const resp = await this.tm.blockchain(height, height);
    return resp.blockMetas[0].header;
  }

  public async waitOneBlock(): Promise<void> {
    // TODO: this works but only for websocket connections, is there some code that falls back to polling in cosmjs?
    // await firstEvent(this.tm.subscribeNewBlockHeader());
    await sleep(500);
  }

  public getCommit(height?: number): Promise<CommitResponse> {
    return this.tm.commit(height);
  }

  public async getSignedHeader(height?: number): Promise<SignedHeader> {
    const { header: rpcHeader, commit: rpcCommit } = await this.getCommit(
      height
    );
    const header = Header.fromPartial({
      ...rpcHeader,
      version: {
        block: new Long(rpcHeader.version.block),
      },
      height: new Long(rpcHeader.height),
      time: timestampFromDateNanos(rpcHeader.time),
      lastBlockId: {
        hash: rpcHeader.lastBlockId.hash,
        partSetHeader: rpcHeader.lastBlockId.parts,
      },
    });

    const signatures = rpcCommit.signatures.map((sig) => ({
      ...sig,
      timestamp: sig.timestamp && timestampFromDateNanos(sig.timestamp),
      blockIdFlag: blockIDFlagFromJSON(sig.blockIdFlag),
    }));
    const commit = Commit.fromPartial({
      height: new Long(rpcCommit.height),
      round: rpcCommit.round,
      blockId: {
        hash: rpcCommit.blockId.hash,
        partSetHeader: rpcCommit.blockId.parts,
      },
      signatures,
    });
    // For the vote sign bytes, it checks (from the commit):
    //   Height, Round, BlockId, TimeStamp, ChainID

    return { header, commit };
  }

  public async getValidatorSet(height: number): Promise<ValidatorSet> {
    // we need to query the header to find out who the proposer was, and pull them out
    const { proposerAddress } = await this.header(height);
    const validators = await this.tm.validators(height);
    const mappedValidators = validators.validators.map((val) => ({
      address: val.address,
      pubKey: mapRpcPubKeyToProto(val.pubkey),
      votingPower: new Long(val.votingPower),
      proposerPriority: val.proposerPriority
        ? new Long(val.proposerPriority)
        : undefined,
    }));
    const totalPower = validators.validators.reduce(
      (x, v) => x + v.votingPower,
      0
    );
    const proposer = mappedValidators.find((val) =>
      arrayContentEquals(val.address, proposerAddress)
    );
    return ValidatorSet.fromPartial({
      validators: mappedValidators,
      totalVotingPower: new Long(totalPower),
      proposer,
    });
  }

  // this builds a header to update a remote client.
  // you must pass the last known height on the remote side so we can properly generate it.
  // it will update to the latest state of this chain.
  //
  // This is the logic that validates the returned struct:
  // ibc check: https://github.com/cosmos/cosmos-sdk/blob/v0.41.0/x/ibc/light-clients/07-tendermint/types/update.go#L87-L167
  // tendermint check: https://github.com/tendermint/tendermint/blob/v0.34.3/light/verifier.go#L19-L79
  // sign bytes: https://github.com/tendermint/tendermint/blob/v0.34.3/types/validator_set.go#L762-L821
  //   * https://github.com/tendermint/tendermint/blob/v0.34.3/types/validator_set.go#L807-L810
  //   * https://github.com/tendermint/tendermint/blob/v0.34.3/types/block.go#L780-L809
  //   * https://github.com/tendermint/tendermint/blob/bf9e36d02d2eb22f6fe8961d0d7d3d34307ba38e/types/canonical.go#L54-L65
  //
  // For the vote sign bytes, it checks (from the commit):
  //   Height, Round, BlockId, TimeStamp, ChainID
  public async buildHeader(lastHeight: number): Promise<TendermintHeader> {
    const signedHeader = await this.getSignedHeader();
    /* eslint @typescript-eslint/no-non-null-assertion: "off" */
    const curHeight = signedHeader.header!.height.toNumber();
    return TendermintHeader.fromPartial({
      signedHeader,
      validatorSet: await this.getValidatorSet(curHeight),
      trustedHeight: {
        revisionHeight: new Long(lastHeight),
      },
      // "assert that trustedVals is NextValidators of last trusted header"
      // https://github.com/cosmos/cosmos-sdk/blob/v0.41.0/x/ibc/light-clients/07-tendermint/types/update.go#L74
      trustedValidators: await this.getValidatorSet(lastHeight + 1),
    });
  }

  // trustedHeight must be proven by the client on the destination chain
  // and include a proof for the connOpenInit (eg. must be 1 or more blocks after the
  // block connOpenInit Tx was in).
  //
  // pass a header height that was previously updated to on the remote chain using updateClient.
  // note: the queries will be for the block before this header, so the proofs match up (appHash is on H+1)
  public async getConnectionProof(
    clientId: string,
    connectionId: string,
    headerHeight: number
  ): Promise<ConnectionHandshakeProof> {
    const queryHeight = headerHeight - 1;

    const {
      clientState,
      proof: proofClient,
      // proofHeight,
    } = await this.query.ibc.proof.client.state(clientId, queryHeight);

    // This is the most recent state we have on this chain of the other
    const {
      latestHeight: consensusHeight,
    } = await this.query.ibc.client.stateTm(clientId);

    // get the init proof
    const {
      proof: proofConnection,
    } = await this.query.ibc.proof.connection.connection(
      connectionId,
      queryHeight
    );

    // get the consensus proof
    const {
      proof: proofConsensus,
    } = await this.query.ibc.proof.client.consensusState(
      clientId,
      toIntHeight(consensusHeight),
      queryHeight
    );

    return {
      clientId,
      clientState,
      connectionId,
      proofHeight: toProtoHeight(headerHeight),
      proofConnection,
      proofClient,
      proofConsensus,
      consensusHeight,
    };
  }

  // trustedHeight must be proven by the client on the destination chain
  // and include a proof for the connOpenInit (eg. must be 1 or more blocks after the
  // block connOpenInit Tx was in).
  //
  // pass a header height that was previously updated to on the remote chain using updateClient.
  // note: the queries will be for the block before this header, so the proofs match up (appHash is on H+1)
  public async getChannelProof(
    id: ChannelInfo,
    headerHeight: number
  ): Promise<ChannelHandshake> {
    const queryHeight = headerHeight - 1;

    const { proof } = await this.query.ibc.proof.channel.channel(
      id.portId,
      id.channelId,
      queryHeight
    );

    return {
      id,
      proofHeight: toProtoHeight(headerHeight),
      proof,
    };
  }

  /*
  These are helpers to query, build data and submit a message
  Currently all prefixed with doXxx, but please look for better naming
  */

  // Updates existing client on this chain with data from src chain.
  // Returns the height that was updated to.
  public async doUpdateClient(
    clientId: string,
    src: IbcClient
  ): Promise<number> {
    const { latestHeight } = await this.query.ibc.client.stateTm(clientId);
    const header = await src.buildHeader(toIntHeight(latestHeight));
    await this.updateTendermintClient(clientId, header);
    return header.signedHeader?.header?.height?.toNumber() ?? 0;
  }

  /***** These are all direct wrappers around message constructors ********/

  public sendTokens(
    recipientAddress: string,
    transferAmount: readonly Coin[],
    memo?: string
  ): Promise<BroadcastTxResponse> {
    return this.sign.sendTokens(
      this.senderAddress,
      recipientAddress,
      transferAmount,
      memo
    );
  }

  public async createTendermintClient(
    clientState: TendermintClientState,
    consensusState: TendermintConsensusState
  ): Promise<CreateClientResult> {
    const senderAddress = this.senderAddress;
    const createMsg = {
      typeUrl: '/ibc.core.client.v1.MsgCreateClient',
      value: MsgCreateClient.fromPartial({
        signer: senderAddress,
        clientState: {
          typeUrl: '/ibc.lightclients.tendermint.v1.ClientState',
          value: TendermintClientState.encode(clientState).finish(),
        },
        consensusState: {
          typeUrl: '/ibc.lightclients.tendermint.v1.ConsensusState',
          value: TendermintConsensusState.encode(consensusState).finish(),
        },
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [createMsg],
      fees.initClient
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);

    const clientId = logs.findAttribute(
      parsedLogs,
      'create_client',
      'client_id'
    ).value;
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
      clientId,
    };
  }

  public async updateTendermintClient(
    clientId: string,
    header: TendermintHeader
  ): Promise<MsgResult> {
    const senderAddress = this.senderAddress;
    const updateMsg = {
      typeUrl: '/ibc.core.client.v1.MsgUpdateClient',
      value: MsgUpdateClient.fromPartial({
        signer: senderAddress,
        clientId,
        header: {
          typeUrl: '/ibc.lightclients.tendermint.v1.Header',
          value: TendermintHeader.encode(header).finish(),
        },
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [updateMsg],
      fees.updateClient
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
    };
  }

  public async connOpenInit(
    clientId: string,
    remoteClientId: string
  ): Promise<CreateConnectionResult> {
    const senderAddress = this.senderAddress;
    const msg = {
      typeUrl: '/ibc.core.connection.v1.MsgConnectionOpenInit',
      value: MsgConnectionOpenInit.fromPartial({
        clientId,
        counterparty: {
          clientId: remoteClientId,
          prefix: defaultMerklePrefix,
        },
        version: defaultConnectionVersion,
        delayPeriod: defaultDelayPeriod,
        signer: senderAddress,
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      fees.initConnection
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    const connectionId = logs.findAttribute(
      parsedLogs,
      'connection_open_init',
      'connection_id'
    ).value;
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
      connectionId,
    };
  }

  public async connOpenTry(
    myClientId: string,
    proof: ConnectionHandshakeProof
  ): Promise<CreateConnectionResult> {
    const senderAddress = this.senderAddress;
    const {
      clientId,
      connectionId,
      clientState,
      proofHeight,
      proofConnection: proofInit,
      proofClient,
      proofConsensus,
      consensusHeight,
    } = proof;
    const msg = {
      typeUrl: '/ibc.core.connection.v1.MsgConnectionOpenTry',
      value: MsgConnectionOpenTry.fromPartial({
        clientId: myClientId,
        counterparty: {
          clientId: clientId,
          connectionId: connectionId,
          prefix: defaultMerklePrefix,
        },
        delayPeriod: defaultDelayPeriod,
        counterpartyVersions: [defaultConnectionVersion],
        signer: senderAddress,
        clientState,
        proofHeight,
        proofInit,
        proofClient,
        proofConsensus,
        consensusHeight,
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      fees.connectionHandshake
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    const myConnectionId = logs.findAttribute(
      parsedLogs,
      'connection_open_try',
      'connection_id'
    ).value;
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
      connectionId: myConnectionId,
    };
  }

  public async connOpenAck(
    myConnectionId: string,
    proof: ConnectionHandshakeProof
  ): Promise<MsgResult> {
    const senderAddress = this.senderAddress;
    const {
      connectionId,
      clientState,
      proofHeight,
      proofConnection: proofTry,
      proofClient,
      proofConsensus,
      consensusHeight,
    } = proof;
    const msg = {
      typeUrl: '/ibc.core.connection.v1.MsgConnectionOpenAck',
      value: MsgConnectionOpenAck.fromPartial({
        connectionId: myConnectionId,
        counterpartyConnectionId: connectionId,
        version: defaultConnectionVersion,
        signer: senderAddress,
        clientState,
        proofHeight,
        proofTry,
        proofClient,
        proofConsensus,
        consensusHeight,
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      fees.connectionHandshake
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
    };
  }

  public async connOpenConfirm(
    proof: ConnectionHandshakeProof
  ): Promise<MsgResult> {
    const senderAddress = this.senderAddress;
    const { connectionId, proofHeight, proofConnection: proofAck } = proof;
    const msg = {
      typeUrl: '/ibc.core.connection.v1.MsgConnectionOpenConfirm',
      value: MsgConnectionOpenConfirm.fromPartial({
        connectionId,
        signer: senderAddress,
        proofHeight,
        proofAck,
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      fees.connectionHandshake
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
    };
  }

  public async channelOpenInit(
    portId: string,
    remotePortId: string,
    ordering: Order,
    connectionId: string,
    version: string
  ): Promise<CreateChannelResult> {
    const senderAddress = this.senderAddress;
    const msg = {
      typeUrl: '/ibc.core.channel.v1.MsgChannelOpenInit',
      value: MsgChannelOpenInit.fromPartial({
        portId,
        channel: {
          state: State.STATE_INIT,
          ordering,
          counterparty: {
            portId: remotePortId,
          },
          connectionHops: [connectionId],
          version,
        },
        signer: senderAddress,
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      fees.initChannel
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    const channelId = logs.findAttribute(
      parsedLogs,
      'channel_open_init',
      'channel_id'
    ).value;
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
      channelId,
    };
  }

  public async channelOpenTry(
    portId: string,
    remote: ChannelInfo,
    ordering: Order,
    connectionId: string,
    version: string,
    counterpartyVersion: string,
    proof: ChannelHandshake
  ): Promise<CreateChannelResult> {
    const senderAddress = this.senderAddress;
    const { proofHeight, proof: proofInit } = proof;
    const msg = {
      typeUrl: '/ibc.core.channel.v1.MsgChannelOpenTry',
      value: MsgChannelOpenTry.fromPartial({
        portId,
        counterpartyVersion,
        channel: {
          state: State.STATE_TRYOPEN,
          ordering,
          counterparty: remote,
          connectionHops: [connectionId],
          version,
        },
        proofInit,
        proofHeight,
        signer: senderAddress,
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      fees.channelHandshake
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    const channelId = logs.findAttribute(
      parsedLogs,
      'channel_open_try',
      'channel_id'
    ).value;
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
      channelId,
    };
  }

  public async channelOpenAck(
    portId: string,
    channelId: string,
    counterpartyChannelId: string,
    counterpartyVersion: string,
    proof: ChannelHandshake
  ): Promise<MsgResult> {
    const senderAddress = this.senderAddress;
    const { proofHeight, proof: proofTry } = proof;
    const msg = {
      typeUrl: '/ibc.core.channel.v1.MsgChannelOpenAck',
      value: MsgChannelOpenAck.fromPartial({
        portId,
        channelId,
        counterpartyChannelId,
        counterpartyVersion,
        proofTry,
        proofHeight,
        signer: senderAddress,
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      fees.channelHandshake
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
    };
  }

  public async channelOpenConfirm(
    portId: string,
    channelId: string,
    proof: ChannelHandshake
  ): Promise<MsgResult> {
    const senderAddress = this.senderAddress;
    const { proofHeight, proof: proofAck } = proof;
    const msg = {
      typeUrl: '/ibc.core.channel.v1.MsgChannelOpenConfirm',
      value: MsgChannelOpenConfirm.fromPartial({
        portId,
        channelId,
        proofAck,
        proofHeight,
        signer: senderAddress,
      }),
    };

    const result = await this.sign.signAndBroadcast(
      senderAddress,
      [msg],
      fees.channelHandshake
    );
    if (isBroadcastTxFailure(result)) {
      throw new Error(createBroadcastTxErrorMessage(result));
    }
    const parsedLogs = parseRawLog(result.rawLog);
    return {
      logs: parsedLogs,
      transactionHash: result.transactionHash,
    };
  }
}

function mapRpcPubKeyToProto(pubkey?: RpcPubKey): ProtoPubKey | undefined {
  if (pubkey === undefined) {
    return undefined;
  }
  if (pubkey.algorithm == 'ed25519') {
    return {
      ed25519: pubkey.data,
      secp256k1: undefined,
    };
  } else if (pubkey.algorithm == 'secp256k1') {
    return {
      ed25519: undefined,
      secp256k1: pubkey.data,
    };
  } else {
    throw new Error(`Unknown validator pubkey type: ${pubkey.algorithm}`);
  }
}

export interface CreateClientArgs {
  clientState: TendermintClientState;
  consensusState: TendermintConsensusState;
}

export async function buildCreateClientArgs(
  src: IbcClient,
  unbondingPeriodSec: number,
  trustPeriodSec: number
): Promise<CreateClientArgs> {
  const header = await src.latestHeader();
  const consensusState = buildConsensusState(header);
  const clientState = buildClientState(
    await src.getChainId(),
    unbondingPeriodSec,
    trustPeriodSec,
    header.height
  );
  return { consensusState, clientState };
}

export function buildConsensusState(
  header: RpcHeader
): TendermintConsensusState {
  return TendermintConsensusState.fromPartial({
    timestamp: timestampFromDateNanos(header.time),
    root: {
      hash: header.appHash,
    },
    nextValidatorsHash: header.nextValidatorsHash,
  });
}

// Note: we hardcode a number of assumptions, like trust level, clock drift, and assume revisionNumber is 1
export function buildClientState(
  chainId: string,
  unbondingPeriodSec: number,
  trustPeriodSec: number,
  height: number
): TendermintClientState {
  // Copied here until https://github.com/confio/ics23/issues/36 is resolved
  // https://github.com/confio/ics23/blob/master/js/src/proofs.ts#L11-L26
  const iavlSpec = {
    leafSpec: {
      prefix: Uint8Array.from([0]),
      hash: HashOp.SHA256,
      prehashValue: HashOp.SHA256,
      prehashKey: HashOp.NO_HASH,
      length: LengthOp.VAR_PROTO,
    },
    innerSpec: {
      childOrder: [0, 1],
      minPrefixLength: 4,
      maxPrefixLength: 12,
      childSize: 33,
      hash: HashOp.SHA256,
    },
  };
  const tendermintSpec = {
    leafSpec: {
      prefix: Uint8Array.from([0]),
      hash: HashOp.SHA256,
      prehashValue: HashOp.SHA256,
      prehashKey: HashOp.NO_HASH,
      length: LengthOp.VAR_PROTO,
    },
    innerSpec: {
      childOrder: [0, 1],
      minPrefixLength: 1,
      maxPrefixLength: 1,
      childSize: 32,
      hash: HashOp.SHA256,
    },
  };

  return TendermintClientState.fromPartial({
    chainId,
    trustLevel: {
      numerator: Long.fromInt(1),
      denominator: Long.fromInt(3),
    },
    unbondingPeriod: {
      seconds: new Long(unbondingPeriodSec),
    },
    trustingPeriod: {
      seconds: new Long(trustPeriodSec),
    },
    maxClockDrift: {
      seconds: new Long(20),
    },
    latestHeight: {
      revisionNumber: new Long(0), // ??
      revisionHeight: new Long(height),
    },
    proofSpecs: [iavlSpec, tendermintSpec],
    upgradePath: ['upgrade', 'upgradedIBCState'],
    allowUpdateAfterExpiry: false,
    allowUpdateAfterMisbehaviour: false,
  });
}

export async function prepareConnectionHandshake(
  src: IbcClient,
  dest: IbcClient,
  clientIdSrc: string,
  clientIdDest: string,
  connIdSrc: string
): Promise<ConnectionHandshakeProof> {
  // ensure the last transaction was committed to the header (one block after it was included)
  await src.waitOneBlock();
  // update client on dest
  const headerHeight = await dest.doUpdateClient(clientIdDest, src);
  // get a proof (for the proven height)
  const proof = await src.getConnectionProof(
    clientIdSrc,
    connIdSrc,
    headerHeight
  );
  return proof;
}

export async function prepareChannelHandshake(
  src: IbcClient,
  dest: IbcClient,
  clientIdDest: string,
  portId: string,
  channelId: string
): Promise<ChannelHandshake> {
  // ensure the last transaction was committed to the header (one block after it was included)
  await src.waitOneBlock();
  // update client on dest
  const headerHeight = await dest.doUpdateClient(clientIdDest, src);
  // get a proof (for the proven height)
  const proof = await src.getChannelProof({ portId, channelId }, headerHeight);
  return proof;
}
