import invariant from 'invariant';
import { createFrame, attachFrame, detatchFrame } from '../lib/frame';
import addSelfRemovableHandler from '../lib/addSelfRemovableHandler';
import BloctoProvider from './blocto';
import {
  SOL_NET_SERVER_MAPPING,
  SOL_NET,
} from '../constants';
import { Buffer } from 'buffer';
// @todo: in the long run we want to remove the dependency of solana web3
import { Transaction, Message, TransactionSignature, TransactionInstruction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

interface SolanaProviderConfig {
  net: string | null;
  server?: string;
  appId: string | null;
}

interface SolanaRequest {
  method: string;
  params?: Object;
}

class SolanaProvider extends BloctoProvider {
  code: string | null = null;
  net: string;
  rpc: string;
  server: string;
  accounts: Array<string> = [];

  constructor({ net = 'mainnet-beta', server, appId }: SolanaProviderConfig) {
    super();

    invariant(net, "'net' is required");
    invariant(SOL_NET.includes(net), 'unsupported net');
    this.net = net;

    this.rpc = `https://api.${net}.solana.com`;

    this.server = server || SOL_NET_SERVER_MAPPING[this.net] || process.env.SERVER || '';
    this.appId = process.env.APP_ID || appId;
  }

  async request(payload: SolanaRequest) {
    if (!this.connected) {
      await this.connect();
    }

    try {
      let response = null;
      let result = null;
      switch (payload.method) {
        case 'connect':
          result = await this.fetchAccounts();
          break;
        case 'getAccounts':
          result = this.accounts.length ? this.accounts : await this.fetchAccounts();
          break;
        // custom JSON-RPC method
        case 'convertToProgramWalletTransaction':
          result = await this.handleConvertTransaction(payload);
          break;
        // custom JSON-RPC method
        case 'signAndSendTransaction':
          result = await this.handleSignAndSendTransaction(payload);
          break;
        // block user from using traditional methods
        case 'signTransaction':
        case 'signAllTransactions':
          throw new Error(`Blocto is program wallet, which doesn\'t support ${payload.method}. Use signAndSendTransaction instead.`);
        default:
          response = await this.handleReadRequests(payload);
      }
      if (response) return response.result;
      return result;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined') { reject('Currently only supported in browser'); }
      const location = encodeURIComponent(window.location.origin);
      const loginFrame = createFrame(`${this.server}/authn?l6n=${location}&chain=solana`);

      attachFrame(loginFrame);

      addSelfRemovableHandler('message', (event: Event, removeListener: Function) => {
        const e = event as MessageEvent;
        if (e.origin === this.server) {
          // @todo: try with another more general event types
          if (e.data.type === 'FCL::CHALLENGE::RESPONSE') {
            removeListener();
            detatchFrame(loginFrame);

            this.code = e.data.code;
            this.connected = true;

            this.accounts = [e.data.addr];
            resolve(this.accounts);
          }

          if (e.data.type === 'FCL::CHALLENGE::CANCEL') {
            removeListener();
            detatchFrame(loginFrame);
            reject();
          }
        }
      });
    });
  }

  async fetchAccounts() {
    const { accounts } = await fetch(
      `${this.server}/api/solana/accounts?code=${this.code}`
    ).then(response => response.json());
    this.accounts = accounts;
    return accounts;
  }

  async handleReadRequests(payload: SolanaRequest) {
    return fetch(this.rpc, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', ...payload }),
    }).then(response => response.json());
  }

  // solana web3 utility
  async convertToProgramWalletTransaction(transaction: Transaction) {
    const message = await this.request({
      method: 'convertToProgramWalletTransaction',
      params: {
        message: transaction.serializeMessage().toString('hex'),
      },
    });
    return this.toTransaction(message, []);
  }

  // solana web3 utility
  async signAndSendTransaction(transaction: Transaction) {
    return this.request({
      method: 'signAndSendTransaction',
      params: {
        signatures: await this.collectSignatures(transaction),
        message: transaction.serializeMessage().toString('hex'),
      },
    });
  }

  // solana web3 utility
  toTransaction(raw: string, signatures: TransactionSignature[]) {
    const message = Message.from(Buffer.from(raw, 'hex'));
    const transaction = new Transaction();
    transaction.recentBlockhash = message.recentBlockhash;
    if (message.header.numRequiredSignatures > 0) {
      transaction.feePayer = message.accountKeys[0];
    }
    signatures.forEach((signature, index) => {
      const sigPubkeyPair = {
        signature:
          signature == PublicKey.default.toBase58()
            ? null
            : bs58.decode(signature),
        publicKey: message.accountKeys[index],
      };
      transaction.signatures.push(sigPubkeyPair);
    });
    message.instructions.forEach((instruction) => {
      const keys = instruction.accounts.map((account) => {
        const pubkey = message.accountKeys[account];
        return {
          pubkey,
          isSigner: account < message.header.numRequiredSignatures,
          isWritable: message.isAccountWritable(account),
        };
      });
      transaction.instructions.push(
        new TransactionInstruction({
          keys,
          programId: message.accountKeys[instruction.programIdIndex],
          data: bs58.decode(instruction.data),
        }),
      );
    });
    return transaction;
  }

  // solana web3 utility
  async collectSignatures(transaction: Transaction) {
    return transaction.signatures.reduce((acc, cur) => {
      if (cur.signature) {
        acc[cur.publicKey.toBase58()] = cur.signature.toString('hex');
      }
      return acc;
    }, {} as { [key: string]: string });
  }

  async handleConvertTransaction(payload: SolanaRequest) {
    return fetch(`${this.server}/api/solana/convertToWalletTx?code=${this.code}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: this.code,
        ...payload.params,
      }),
    }).then(response => response.json());
  }

  async handleSignAndSendTransaction(payload: SolanaRequest) {
    const { authorizationId } = await fetch(`${this.server}/api/solana/authz?code=${this.code}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: this.code,
        ...payload.params,
      }),
    }).then(response => response.json());

    if (typeof window === 'undefined') {
      throw (new Error('Currently only supported in browser'));
    }

    const authzFrame = createFrame(`${this.server}/authz/solana/${authorizationId}`);

    attachFrame(authzFrame);

    return new Promise((resolve, reject) => {
      let pollingId: ReturnType<typeof setTimeout>;
      const pollAuthzStatus = () => fetch(
        `${this.server}/api/solana/authz?authorizationId=${authorizationId}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        })
        .then(response => response.json())
        .then(({ status, transactionHash }) => {
          if (status === 'APPROVED') {
            detatchFrame(authzFrame);
            clearInterval(pollingId);

            resolve(transactionHash);
          }

          if (status === 'DECLINED') {
            detatchFrame(authzFrame);
            clearInterval(pollingId);

            reject('Transaction Canceled');
          }
        });

      pollingId = setInterval(pollAuthzStatus, 1000);
    });
  }
}

export default SolanaProvider;
