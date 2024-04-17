import { Address, OutPoint, PackedSince, Script } from '@ckb-lumos/base';
import { BI, BIish, Cell, helpers, HexString, Indexer } from '@ckb-lumos/lumos';
import { FromInfo } from '@ckb-lumos/common-scripts';
import { SporeDataProps, injectNewSporeOutput, injectNewSporeIds, getClusterAgentByOutPoint } from '../..';
import { getSporeByOutPoint, injectLiveSporeCell } from '../..';
import { getSporeConfig, getSporeScript, SporeConfig } from '../../../config';
import { generateCreateSporeAction, generateMeltSporeAction, injectCommonCobuildProof } from '../../../cobuild';
import {
  assertTransactionSkeletonSize,
  createCapacitySnapshotFromTransactionSkeleton,
  injectCapacityAndPayFee,
  returnExceededCapacityAndPayFee,
  setupCell,
} from '../../../helpers';
import { TransactionSkeletonType, encodeToAddress } from '@ckb-lumos/lumos/helpers';

function InjectCobuildForMeltThenCreateSpore(
  meltSporeInputIndex: number,
  mintSporeCell: Cell,
  mintSporeReference: Awaited<ReturnType<typeof injectNewSporeOutput>>['reference'],
  mintSporeOutputIndex: number,
  txSkeleton: TransactionSkeletonType,
  config: SporeConfig,
): TransactionSkeletonType {
  const sporeScript = getSporeScript(config, 'Spore', mintSporeCell.cellOutput.type!);
  if (sporeScript.behaviors?.cobuild) {
    const meltActionResult = generateMeltSporeAction({
      txSkeleton,
      inputIndex: meltSporeInputIndex,
    });
    const mintActionResult = generateCreateSporeAction({
      txSkeleton,
      reference: mintSporeReference,
      outputIndex: mintSporeOutputIndex,
    });
    const actions = meltActionResult.actions.concat(mintActionResult.actions);
    const injectCobuildProofResult = injectCommonCobuildProof({
      txSkeleton,
      actions,
    });
    txSkeleton = injectCobuildProofResult.txSkeleton;
  }
  return txSkeleton;
}

export async function meltThenCreateSpore(props: {
  outPoint: OutPoint;
  changeAddress?: Address;
  updateWitness?: HexString | ((witness: HexString) => HexString);
  defaultWitness?: HexString;
  since?: PackedSince;
  config?: SporeConfig;
  data: SporeDataProps;
  toLock: Script;
  fromInfos: FromInfo[];
  prefixInputs?: Cell[];
  prefixOutputs?: Cell[];
  postInputs?: Cell[];
  postOutputs?: Cell[];
  feeRate?: BIish | undefined;
  updateOutput?: (cell: Cell) => Cell;
  capacityMargin?: BIish | ((cell: Cell, margin: BI) => BIish);
  cluster?: {
    updateOutput?: (cell: Cell) => Cell;
    capacityMargin?: BIish | ((cell: Cell, margin: BI) => BIish);
    updateWitness?: HexString | ((witness: HexString) => HexString);
  };
  clusterAgentOutPoint?: OutPoint;
  clusterAgent?: {
    updateOutput?: (cell: Cell) => Cell;
    capacityMargin?: BIish | ((cell: Cell, margin: BI) => BIish);
    updateWitness?: HexString | ((witness: HexString) => HexString);
  };
  mutant?: {
    paymentAmount?: (minPayment: BI, lock: Script, cell: Cell) => BIish;
  };
  maxTransactionSize?: number | false;
}): Promise<{
  txSkeleton: helpers.TransactionSkeletonType;
  inputIndex: number;
  outputIndex: number;
  reference: Awaited<ReturnType<typeof injectNewSporeOutput>>['reference'];
  mutantReference: Awaited<ReturnType<typeof injectNewSporeOutput>>['mutantReference'];
}> {
  /**
   * Melt Spore with Spore Outputpoint
   */

  // Env
  const config = props.config ?? getSporeConfig();
  const indexer = new Indexer(config.ckbIndexerUrl, config.ckbNodeUrl);
  const capacityMargin = BI.from(props.capacityMargin ?? 1_0000_0000);
  const maxTransactionSize = props.maxTransactionSize ?? config.maxTransactionSize ?? false;

  // MeltTransactionSkeleton
  let txSkeleton = helpers.TransactionSkeleton({
    cellProvider: indexer,
  });

  // Insert input cells in advance for particular purpose
  if (props.prefixInputs) {
    for (const cell of props.prefixInputs!) {
      const address = encodeToAddress(cell.cellOutput.lock, { config: config.lumos });
      const customScript = {
        script: cell.cellOutput.lock,
        customData: cell.data,
      };
      if (props.fromInfos.indexOf(address) < 0 && props.fromInfos.indexOf(customScript) < 0) {
        props.fromInfos.push(address);
      }
      const setupCellResult = await setupCell({
        txSkeleton,
        input: cell,
        updateWitness: props.updateWitness,
        defaultWitness: props.defaultWitness,
        config: config.lumos,
      });
      txSkeleton = setupCellResult.txSkeleton;
    }
  }

  // Insert output cells in advance for particular purpose
  if (props.prefixOutputs) {
    txSkeleton = txSkeleton.update('outputs', (outputs) => {
      props.prefixOutputs!.forEach((cell) => (outputs = outputs.push(cell)));
      return outputs;
    });
  }

  // Apply `fromInfos` in advance if postInputs is provided
  if (props.postInputs) {
    for (const cell of props.postInputs!) {
      const address = encodeToAddress(cell.cellOutput.lock, { config: config.lumos });
      const customScript = {
        script: cell.cellOutput.lock,
        customData: cell.data,
      };
      if (props.fromInfos.indexOf(address) < 0 && props.fromInfos.indexOf(customScript) < 0) {
        props.fromInfos.push(address);
      }
    }
  }

  // Inject live spore to Transaction.inputs
  const meltSporeCell = await getSporeByOutPoint(props.outPoint, config);
  const injectLiveSporeCellResult = await injectLiveSporeCell({
    txSkeleton,
    cell: meltSporeCell,
    updateWitness: props.updateWitness,
    defaultWitness: props.defaultWitness,
    since: props.since,
    config,
  });
  txSkeleton = injectLiveSporeCellResult.txSkeleton;

  /**
   * Create Spore
   */

  // If referencing a ClusterAgent, get it from the OutPoint
  let clusterAgentCell: Cell | undefined;
  if (props.clusterAgentOutPoint) {
    clusterAgentCell = await getClusterAgentByOutPoint(props.clusterAgentOutPoint, config);
  }

  const prefixOutputLocks = props.prefixOutputs ? props.prefixOutputs.map((cell) => cell.cellOutput.lock) : [];
  const postOutputLocks = props.postOutputs ? props.postOutputs.map((cell) => cell.cellOutput.lock) : [];
  const injectNewSporeResult = await injectNewSporeOutput({
    txSkeleton,
    data: props.data,
    toLock: props.toLock,
    fromInfos: props.fromInfos,
    extraOutputLocks: prefixOutputLocks.concat(postOutputLocks),
    changeAddress: props.changeAddress,
    updateOutput: props.updateOutput,
    clusterAgent: props.clusterAgent,
    cluster: props.cluster,
    mutant: props.mutant,
    clusterAgentCell,
    capacityMargin,
    config,
  });
  txSkeleton = injectNewSporeResult.txSkeleton;

  // Insert input cells in the end for particular purpose
  if (props.postInputs) {
    for (const cell of props.postInputs!) {
      const setupCellResult = await setupCell({
        txSkeleton,
        input: cell,
        updateWitness: props.updateWitness,
        defaultWitness: props.defaultWitness,
        config: config.lumos,
      });
      txSkeleton = setupCellResult.txSkeleton;
    }
  }

  // Insert output cells in the end for particular purpose
  if (props.postOutputs) {
    txSkeleton = txSkeleton.update('outputs', (outputs) => {
      props.postOutputs!.forEach((cell) => (outputs = outputs.push(cell)));
      return outputs;
    });
  }

  /**
   * check wether Redeem or Inject Capacity and then Pay fee
   */
  const snapshot = createCapacitySnapshotFromTransactionSkeleton(txSkeleton);
  if (snapshot.inputsCapacity > snapshot.outputsCapacity) {
    /**
     * Complete Co-Build WitnessLayout
     */
    txSkeleton = injectNewSporeIds({
      outputIndices: [injectNewSporeResult.outputIndex],
      txSkeleton,
      config,
    });
    const mintSporeCell = txSkeleton.get('outputs').get(injectNewSporeResult.outputIndex)!;
    txSkeleton = InjectCobuildForMeltThenCreateSpore(
      injectLiveSporeCellResult.inputIndex,
      mintSporeCell,
      injectNewSporeResult.reference,
      injectNewSporeResult.outputIndex,
      txSkeleton,
      config,
    );

    // Redeem capacity from the exceeded capacity
    const sporeAddress = helpers.encodeToAddress(mintSporeCell.cellOutput.lock, { config: config.lumos });
    const returnExceededCapacityAndPayFeeResult = await returnExceededCapacityAndPayFee({
      txSkeleton,
      changeAddress: props.changeAddress ?? sporeAddress,
      feeRate: props.feeRate,
      fromInfos: props.fromInfos,
      config,
    });
    txSkeleton = returnExceededCapacityAndPayFeeResult.txSkeleton;
  } else {
    /**
     * Inject Capacity and Pay fee
     */
    const injectCapacityAndPayFeeResult = await injectCapacityAndPayFee({
      txSkeleton,
      fromInfos: props.fromInfos,
      changeAddress: props.changeAddress,
      config,
      feeRate: props.feeRate,
      updateTxSkeletonAfterCollection(_txSkeleton) {
        // Generate and inject SporeID
        _txSkeleton = injectNewSporeIds({
          outputIndices: [injectNewSporeResult.outputIndex],
          txSkeleton: _txSkeleton,
          config,
        });

        /**
         * Complete Co-Build WitnessLayout
         */

        const mintSporeCell = txSkeleton.get('outputs').get(injectNewSporeResult.outputIndex)!;
        _txSkeleton = InjectCobuildForMeltThenCreateSpore(
          injectLiveSporeCellResult.inputIndex,
          mintSporeCell,
          injectNewSporeResult.reference,
          injectNewSporeResult.outputIndex,
          _txSkeleton,
          config,
        );

        return _txSkeleton;
      },
    });
    txSkeleton = injectCapacityAndPayFeeResult.txSkeleton;
  }

  // Make sure the tx size is in range (if needed)
  if (typeof maxTransactionSize === 'number') {
    assertTransactionSkeletonSize(txSkeleton, void 0, maxTransactionSize);
  }

  return {
    txSkeleton,
    inputIndex: injectLiveSporeCellResult.inputIndex,
    outputIndex: injectNewSporeResult.outputIndex,
    reference: injectNewSporeResult.reference,
    mutantReference: injectNewSporeResult.mutantReference,
  };
}
