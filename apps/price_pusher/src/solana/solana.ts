import { PythSolanaReceiverProgram } from "@pythnetwork/pyth-solana-receiver";
import {
  ChainPriceListener,
  IPricePusher,
  PriceInfo,
  PriceItem,
} from "../interface";
import { DurationInSeconds } from "../utils";
import { PriceServiceConnection } from "@pythnetwork/price-service-client";
import {
  sendTransactions,
  TransactionBuilder,
} from "@pythnetwork/solana-utils";
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, PublicKey, TransactionError, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DriftClient, getPythPullOraclePublicKey, isSetComputeUnitsIx, PriorityFeeSubscriber, TxSigAndSlot } from "@drift-labs/sdk";
import { getFeedIdUint8Array } from "@drift-labs/sdk/lib/util/pythPullOracleUtils"
import { PriceUpdateAccount } from "@pythnetwork/pyth-solana-receiver/lib/PythSolanaReceiver";
import { Program } from "@coral-xyz/anchor";
import { base64 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

export class SolanaPriceListener extends ChainPriceListener {
  // @ts-ignore
  pythSolanaReceiver: Program<PythSolanaReceiverProgram>;

  constructor(
    private driftClient: DriftClient,
    priceItems: PriceItem[],
    config: {
      pollingFrequency: DurationInSeconds;
    }
  ) {
    super("solana", config.pollingFrequency, priceItems);
    // @ts-ignore
    this.pythSolanaReceiver = this.driftClient.getReceiverProgram();
  }

  getPriceFeedAccountAddress(priceId: string) {
    return getPythPullOraclePublicKey(
      this.driftClient.program.programId, 
      getFeedIdUint8Array(priceId)
    )
  }

  async fetchPriceFeedAccount(priceId: string): Promise<PriceUpdateAccount | null> {
    // @ts-ignore
    return await this.pythSolanaReceiver.account.priceUpdateV2.fetchNullable(
      this.getPriceFeedAccountAddress(priceId),
      'confirmed'
    )
  }

  async getOnChainPriceInfo(priceId: string): Promise<PriceInfo | undefined> {
    try {
      const priceFeedAccount =
        await this.fetchPriceFeedAccount(
          priceId
        );
      console.log(
        `Polled a Solana on chain price for feed ${this.priceIdToAlias.get(
          priceId
        )} (${priceId}).`
      );
      if (priceFeedAccount) {
        return {
          conf: priceFeedAccount.priceMessage.conf.toString(),
          price: priceFeedAccount.priceMessage.price.toString(),
          publishTime: priceFeedAccount.priceMessage.publishTime.toNumber(),
        };
      } else {
        return undefined;
      }
    } catch (e) {
      console.error(`Polling on-chain price for ${priceId} failed. Error:`);
      console.error(e);
      return undefined;
    }
  }
}

export class SolanaPricePusher implements IPricePusher {
  constructor(
    private driftClient: DriftClient,
    private priceServiceConnection: PriceServiceConnection,
    private priorityFeeSubscriber: PriorityFeeSubscriber,
    private addressLookupTable: AddressLookupTableAccount
  ) {
  }

  async pushPriceUpdatesAtomic(
    priceIds: string[],
  ): Promise<void> {
    if (priceIds.length === 0) {
      return;
    }

    for (const priceId of priceIds) {
      let priceFeedUpdateData: string[];
      try {
        priceFeedUpdateData = await this.priceServiceConnection.getLatestVaas(
          [priceId]
        );
      } catch (e: any) {
        console.error(new Date(), "getPriceFeedsUpdateData failed:", e);
        return
      }
      

      const ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 1_400_000,
        }),
      ];
      const priorityFees = Math.floor(
        (this.priorityFeeSubscriber?.getCustomStrategyResult() || 0) *
          this.driftClient.txSender.getSuggestedPriorityFeeMultiplier()
      );
      console.log(
        `Priority fees to use: ${priorityFees} with multiplier: ${this.driftClient.txSender.getSuggestedPriorityFeeMultiplier()}`
      );
      ixs.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFees,
        })
      );

      ixs.push(...await this.driftClient.getPostPythPullOracleUpdateAtomicIxs(
        priceFeedUpdateData[0],
        priceId,
        3
      ));
      const simResult = await simulateAndGetTxWithCUs({
        ixs,
        connection: this.driftClient.connection,
        payerPublicKey: this.driftClient.wallet.publicKey,
        lookupTableAccounts: [this.addressLookupTable],
        cuLimitMultiplier: 1.35,
        doSimulation: true,
        recentBlockhash: (await this.driftClient.connection.getLatestBlockhash()).blockhash,
      });
      if (!simResult.simError) {
        this.driftClient
        .sendTransaction(simResult.tx)
        .then((txSigAndSlot: TxSigAndSlot) => {
          console.log(new Date(), `updatePriceFeed successful: ${txSigAndSlot.txSig}`);
        })
        .catch((e) => {
          console.error(new Date(), "updatePriceFeed failed", e);
        });
      } else {
        console.error(new Date(), "updatePriceFeed failed", JSON.stringify(simResult.simError));
      }
    }
  }
}

const UPDATES_PER_JITO_BUNDLE = 5;

export class SolanaPricePusherJito implements IPricePusher {
  constructor(
    private driftClient: DriftClient,
    private priceServiceConnection: PriceServiceConnection,
    private jitoTipLamports: number,
    private jitoBundleSize: number,
    private addressLookupTable: AddressLookupTableAccount
  ) {}

  async pushPriceUpdatesAtomic(
    priceIds: string[],
  ): Promise<void> {
    if (priceIds.length === 0) {
      return;
    }

    let priceFeedUpdateData: string[];
    try {
      priceFeedUpdateData = await this.priceServiceConnection.getLatestVaas(
        priceIds
      );
    } catch (e: any) {
      console.error(new Date(), "getPriceFeedsUpdateData failed:", e);
      return;
    }

    for (let i = 0; i < priceIds.length; i += UPDATES_PER_JITO_BUNDLE) {
      const transactionBuilder = new TransactionBuilder(
        this.driftClient.wallet.publicKey,
        this.driftClient.connection,
        this.addressLookupTable
      );
      const priceId = priceIds[i];
      const ixs = await this.driftClient.getPostPythPullOracleUpdateAtomicIxs(
        priceFeedUpdateData[0],
        priceId,
      )
      const ixsWithEmphemeralSigners = ixs.map((ix) => {
        return {
          instruction: ix,
          signers: [],
        }
      })
      transactionBuilder.addInstructions(ixsWithEmphemeralSigners);
      const transactions = await transactionBuilder.buildVersionedTransactions({
        jitoTipLamports: this.jitoTipLamports,
        tightComputeBudget: true,
        jitoBundleSize: this.jitoBundleSize,
      });
  
      try {
        await sendTransactions(
          transactions,
          this.driftClient.connection,
          // @ts-ignore
          this.driftClient.wallet
        );
        console.log(new Date(), "updatePriceFeed successful");
      } catch (e: any) {
        console.error(new Date(), "updatePriceFeed failed", e);
        return;
      }
    }

   
  }
}

const PLACEHOLDER_BLOCKHASH = 'Fdum64WVeej6DeL85REV9NvfSxEJNPZ74DBk7A8kTrKP';
function getVersionedTransaction(
	payerKey: PublicKey,
	ixs: Array<TransactionInstruction>,
	lookupTableAccounts: AddressLookupTableAccount[],
	recentBlockhash: string
): VersionedTransaction {
	const message = new TransactionMessage({
		payerKey,
		recentBlockhash,
		instructions: ixs,
	}).compileToV0Message(lookupTableAccounts);

	return new VersionedTransaction(message);
}

export type SimulateAndGetTxWithCUsParams = {
	connection: Connection;
	payerPublicKey: PublicKey;
	lookupTableAccounts: AddressLookupTableAccount[];
	/// instructions to simulate and create transaction from
	ixs: Array<TransactionInstruction>;
	/// multiplier to apply to the estimated CU usage, default: 1.0
	cuLimitMultiplier?: number;
	/// minimum CU limit to use, will not use a min CU if not set
	minCuLimit?: number;
	/// set false to only create a tx without simulating for CU estimate
	doSimulation?: boolean;
	/// recentBlockhash to use in the final tx. If undefined, PLACEHOLDER_BLOCKHASH
	/// will be used for simulation, the final tx will have an empty blockhash so
	/// attempts to sign it will throw.
	recentBlockhash?: string;
	/// set true to dump base64 transaction before and after simulating for CUs
	dumpTx?: boolean;
};

export type SimulateAndGetTxWithCUsResponse = {
	cuEstimate: number;
	simTxLogs: Array<string> | null;
	simError: TransactionError | string | null;
	simTxDuration: number;
	tx: VersionedTransaction;
};

/**
 * Simulates the instructions in order to determine how many CUs it needs,
 * applies `cuLimitMulitplier` to the estimate and inserts or modifies
 * the CU limit request ix.
 *
 * If `recentBlockhash` is provided, it is used as is to generate the final
 * tx. If it is undefined, uses `PLACEHOLDER_BLOCKHASH` which is a valid
 * blockhash to perform simulation and removes it from the final tx. Signing
 * a tx without a valid blockhash will throw.
 * @param params
 * @returns
 */
export async function simulateAndGetTxWithCUs(
	params: SimulateAndGetTxWithCUsParams
): Promise<SimulateAndGetTxWithCUsResponse> {
	if (params.ixs.length === 0) {
		throw new Error('cannot simulate empty tx');
	}

	let setCULimitIxIdx = -1;
	for (let idx = 0; idx < params.ixs.length; idx++) {
		if (isSetComputeUnitsIx(params.ixs[idx])) {
			setCULimitIxIdx = idx;
			break;
		}
	}

	// if we don't have a set CU limit ix, add one to the beginning
	// otherwise the default CU limit for sim is 400k, which may be too low
	if (setCULimitIxIdx === -1) {
		params.ixs.unshift(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 1_400_000,
			})
		);
		setCULimitIxIdx = 0;
	}
	let simTxDuration = 0;

	const tx = getVersionedTransaction(
		params.payerPublicKey,
		params.ixs,
		params.lookupTableAccounts,
		params.recentBlockhash ?? PLACEHOLDER_BLOCKHASH
	);

	if (!params.doSimulation) {
		return {
			cuEstimate: -1,
			simTxLogs: null,
			simError: null,
			simTxDuration,
			tx,
		};
	}
	if (params.dumpTx) {
		console.log(`===== Simulating The following transaction =====`);
		const serializedTx = base64.encode(Buffer.from(tx.serialize()));
		console.log(serializedTx);
		console.log(`================================================`);
	}

	let resp;
	try {
		const start = Date.now();
		resp = await params.connection.simulateTransaction(tx, {
			sigVerify: false,
			replaceRecentBlockhash: true,
			commitment: 'processed',
		});
		simTxDuration = Date.now() - start;
	} catch (e) {
		console.error(e);
	}
	if (!resp) {
		throw new Error('Failed to simulate transaction');
	}

	if (resp.value.unitsConsumed === undefined) {
		throw new Error(`Failed to get units consumed from simulateTransaction`);
	}

	const simTxLogs = resp.value.logs;
	const cuEstimate = resp.value.unitsConsumed!;
	const cusToUse = Math.max(
		cuEstimate * (params.cuLimitMultiplier ?? 1.0),
		params.minCuLimit ?? 0
	);
	params.ixs[setCULimitIxIdx] = ComputeBudgetProgram.setComputeUnitLimit({
		units: cusToUse,
	});

	const txWithCUs = getVersionedTransaction(
		params.payerPublicKey,
		params.ixs,
		params.lookupTableAccounts,
		params.recentBlockhash ?? PLACEHOLDER_BLOCKHASH
	);

	if (params.dumpTx) {
		console.log(
			`== Simulation result, cuEstimate: ${cuEstimate}, using: ${cusToUse}, blockhash: ${params.recentBlockhash} ==`
		);
		const serializedTx = base64.encode(Buffer.from(txWithCUs.serialize()));
		console.log(serializedTx);
		console.log(`================================================`);
	}

	// strip out the placeholder blockhash so user doesn't try to send the tx.
	// sending a tx with placeholder blockhash will cause `blockhash not found error`
	// which is suppressed if flight checks are skipped.
	if (!params.recentBlockhash) {
		txWithCUs.message.recentBlockhash = '';
	}

	return {
		cuEstimate,
		simTxLogs,
		simTxDuration,
		simError: resp.value.err,
		tx: txWithCUs,
	};
}
