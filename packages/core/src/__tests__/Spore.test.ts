import { describe, expect, it, afterAll } from 'vitest';
import { BI, Cell, Indexer, helpers } from '@ckb-lumos/lumos';
import { ParamsFormatter } from '@ckb-lumos/rpc';
import { getSporeScript } from '../config';
import {
  bufferToRawString,
  bytifyRawString,
  createCapacitySnapshotFromTransactionSkeleton,
  getCellByLock,
} from '../helpers';
import {
  createSpore,
  transferSpore,
  meltSpore,
  getSporeByOutPoint,
  createCluster,
  getClusterByOutPoint,
  createMultipleSpores,
} from '../api';
import { expectCellDep, expectTypeId, expectTypeCell, expectCellLock, Account, expectCell } from './helpers';
import { getSporeOutput, popRecord, retryQuery, signAndOrSendTransaction, OutPointRecord } from './helpers';
import { TEST_ACCOUNTS, TEST_ENV, SPORE_OUTPOINT_RECORDS, cleanupRecords } from './shared';
import { meltThenCreateSpore } from '../api/composed/spore/meltThenCreateSpore';
import { SporeAction, WitnessLayout } from '../cobuild';
import { common } from '@ckb-lumos/lumos/common-scripts';

describe('Spore', () => {
  const { rpc, config } = TEST_ENV;
  const { CHARLIE, ALICE, BOB } = TEST_ACCOUNTS;

  async function getLiveCell(account: Account, nullable: boolean): Promise<Cell | undefined> {
    const indexer = new Indexer(config.ckbIndexerUrl);
    const cell = getCellByLock({
      lock: account.lock,
      indexer,
      has_type: false,
    });
    if (!nullable && !cell) {
      throw new Error(`live cell not found in ${account}`);
    }
    return cell;
  }

  afterAll(async () => {
    await cleanupRecords({
      name: 'Spore',
    });
  }, 0);

  describe('Spore basics', () => {
    let existingSporeRecord: OutPointRecord | undefined;
    it('Create a Spore', async () => {
      const capacityCell = await getLiveCell(CHARLIE, true);
      const { txSkeleton, outputIndex, reference } = await createSpore({
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('content'),
        },
        toLock: CHARLIE.lock,
        fromInfos: [],
        prefixInputs: [capacityCell!],
        config,
      });

      const spore = getSporeOutput(txSkeleton, outputIndex, config);
      expect(spore.cell!.cellOutput.lock).toEqual(CHARLIE.lock);
      expectTypeId(txSkeleton, outputIndex, spore.id);
      expect(spore.data.contentType).toEqual('text/plain');
      expect(bufferToRawString(spore.data.content)).toEqual('content');

      expectTypeCell(txSkeleton, 'output', spore.cell.cellOutput.type!);
      expectCellDep(txSkeleton, spore.script.cellDep);

      expect(reference).toBeDefined();
      expect(reference.referenceTarget).toEqual('none');

      const { hash } = await signAndOrSendTransaction({
        account: CHARLIE,
        txSkeleton,
        config,
        rpc,
        send: true,
      });

      if (hash) {
        SPORE_OUTPOINT_RECORDS.push({
          outPoint: {
            txHash: hash,
            index: BI.from(outputIndex).toHexString(),
          },
          account: CHARLIE,
        });
      }
    }, 0);
    it('Transfer a Spore', async () => {
      const sporeRecord = existingSporeRecord ?? popRecord(SPORE_OUTPOINT_RECORDS, true);
      const sporeCell = await retryQuery(() => getSporeByOutPoint(sporeRecord.outPoint, config));

      expectCellLock(sporeCell, [CHARLIE.lock, ALICE.lock]);
      const oppositeAccount = sporeRecord.account.address === ALICE.address ? CHARLIE : ALICE;

      const { txSkeleton, outputIndex } = await transferSpore({
        outPoint: sporeCell.outPoint!,
        fromInfos: [sporeRecord.account.address],
        toLock: oppositeAccount.lock,
        config,
      });

      const spore = getSporeOutput(txSkeleton, outputIndex, config);
      expect(spore.cell.cellOutput.lock).toEqual(oppositeAccount.lock);

      expectTypeCell(txSkeleton, 'both', spore.cell.cellOutput.type!);
      expectCellDep(txSkeleton, spore.script.cellDep);

      const { hash } = await signAndOrSendTransaction({
        account: sporeRecord.account,
        txSkeleton,
        config,
        rpc,
        send: true,
      });
      if (hash) {
        existingSporeRecord = void 0;
        SPORE_OUTPOINT_RECORDS.push({
          outPoint: {
            txHash: hash,
            index: BI.from(outputIndex).toHexString(),
          },
          account: ALICE,
        });
      }
    }, 0);
    it('Melt a Spore', async () => {
      const sporeRecord = existingSporeRecord ?? popRecord(SPORE_OUTPOINT_RECORDS, true);
      const sporeCell = await retryQuery(() => getSporeByOutPoint(sporeRecord.outPoint, config));

      const { txSkeleton } = await meltSpore({
        outPoint: sporeCell.outPoint!,
        changeAddress: CHARLIE.address,
        config,
      });

      expectTypeCell(txSkeleton, 'input', sporeCell.cellOutput.type!);

      const changeCell = txSkeleton.get('outputs').get(0);
      expect(changeCell).toBeDefined();
      expect(changeCell!.cellOutput.lock).toEqual(CHARLIE.lock);

      const sporeScript = getSporeScript(config, 'Spore', sporeCell.cellOutput.type!);
      expectCellDep(txSkeleton, sporeScript.cellDep);

      const { hash } = await signAndOrSendTransaction({
        account: sporeRecord.account,
        txSkeleton,
        config,
        rpc,
        send: true,
      });
      if (hash) {
        existingSporeRecord = void 0;
      }
    }, 0);
    it('Create multiple Spores', async () => {
      const { txSkeleton, outputIndices } = await createMultipleSpores({
        sporeInfos: [
          {
            data: {
              contentType: 'text/plain',
              content: bytifyRawString('content-1'),
            },
            toLock: CHARLIE.lock,
          },
          {
            data: {
              contentType: 'text/plain',
              content: bytifyRawString('content-2'),
            },
            toLock: CHARLIE.lock,
          },
        ],
        fromInfos: [BOB.address],
        config,
      });

      // debug print witness layout
      const lastWitness = txSkeleton.get('witnesses').last();
      const witnessLayout = WitnessLayout.unpack(lastWitness!);
      if (witnessLayout.type === 'SighashAll') {
        const actions = witnessLayout.value.message!.actions;
        const actionsData = actions.map((action) => SporeAction.unpack(action.data));
        console.log(JSON.stringify(actionsData, null, 2));
      }

      const { hash } = await signAndOrSendTransaction({
        account: BOB,
        txSkeleton,
        config,
        rpc,
        send: true,
      });
      if (hash) {
        for (const outputIndex of outputIndices) {
          SPORE_OUTPOINT_RECORDS.push({
            outPoint: {
              txHash: hash,
              index: BI.from(outputIndex).toHexString(),
            },
            account: CHARLIE,
          });
        }
      }
    });
  }, 0);

  describe('Spore with immortal mutant', () => {
    let existingSporeRecord: OutPointRecord | undefined;
    it('Create an immortal Spore', async () => {
      const { txSkeleton, outputIndex } = await createSpore({
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('immortal'),
          contentTypeParameters: {
            immortal: true,
          },
        },
        toLock: CHARLIE.lock,
        fromInfos: [CHARLIE.address],
        config,
      });

      const spore = getSporeOutput(txSkeleton, outputIndex, config);
      expect(spore.cell!.cellOutput.lock).toEqual(CHARLIE.lock);
      expect(spore.data.contentType).toEqual('text/plain;immortal=true');
      expect(bufferToRawString(spore.data.content)).toEqual('immortal');

      const { hash } = await signAndOrSendTransaction({
        account: CHARLIE,
        txSkeleton,
        config,
        rpc,
        send: true,
      });
      if (hash) {
        existingSporeRecord = {
          outPoint: {
            txHash: hash,
            index: BI.from(outputIndex).toHexString(),
          },
          account: CHARLIE,
        };
      }
    }, 0);
    it('Transfer an immortal Spore', async () => {
      expect(existingSporeRecord).toBeDefined();
      const sporeRecord = existingSporeRecord!;
      const sporeCell = await retryQuery(() => getSporeByOutPoint(sporeRecord!.outPoint, config));

      expectCellLock(sporeCell, [CHARLIE.lock, ALICE.lock]);
      const oppositeAccount = sporeRecord.account.address === ALICE.address ? CHARLIE : ALICE;

      const { txSkeleton, outputIndex } = await transferSpore({
        outPoint: sporeCell.outPoint!,
        fromInfos: [sporeRecord.account.address],
        toLock: oppositeAccount.lock,
        config,
      });

      const { hash } = await signAndOrSendTransaction({
        account: sporeRecord.account,
        txSkeleton,
        config,
        rpc,
        send: true,
      });
      if (hash) {
        existingSporeRecord = {
          outPoint: {
            txHash: hash,
            index: BI.from(outputIndex).toHexString(),
          },
          account: oppositeAccount,
        };
      }
    }, 0);
    it('Try melt an immortal Spore', async () => {
      expect(existingSporeRecord).toBeDefined();
      const sporeRecord = existingSporeRecord!;
      const sporeCell = await retryQuery(() => getSporeByOutPoint(sporeRecord!.outPoint, config));

      const { txSkeleton } = await meltSpore({
        outPoint: sporeCell.outPoint!,
        changeAddress: CHARLIE.address,
        config,
      });

      await expect(
        signAndOrSendTransaction({
          account: sporeRecord.account,
          txSkeleton,
          config,
          rpc,
          send: true,
        }),
      ).rejects.toThrow();
    }, 0);
  });

  describe('Spore melt and mint in one transaction', () => {
    let existingSporeRecord: OutPointRecord | undefined;
    let existingClusterRecord: OutPointRecord | undefined;

    it('Create a Cluster', async () => {
      const { txSkeleton, outputIndex } = await createCluster({
        data: {
          name: 'dob cluster',
          description: 'Testing only',
        },
        fromInfos: [BOB.address],
        toLock: BOB.lock,
        config,
      });

      const { hash } = await signAndOrSendTransaction({
        account: BOB,
        txSkeleton,
        config,
        rpc,
        send: true,
      });

      if (hash) {
        existingClusterRecord = {
          outPoint: {
            txHash: hash,
            index: BI.from(outputIndex).toHexString(),
          },
          account: BOB,
        };
      }
    }, 60000);

    it('Create a Spore', async () => {
      const { txSkeleton, outputIndex, reference } = await createSpore({
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('blind box spore with bigger capacity than opened one'),
        },
        toLock: ALICE.lock,
        fromInfos: [ALICE.address],
        config,
      });

      const spore = getSporeOutput(txSkeleton, outputIndex, config);
      expect(spore.cell!.cellOutput.lock).toEqual(ALICE.lock);
      expectTypeId(txSkeleton, outputIndex, spore.id);
      expectCellDep(txSkeleton, spore.script.cellDep);
      expectTypeCell(txSkeleton, 'output', spore.cell.cellOutput.type!);

      expect(reference).toBeDefined();
      expect(reference.referenceTarget).toEqual('none');

      const { hash } = await signAndOrSendTransaction({
        account: ALICE,
        txSkeleton,
        config,
        rpc,
        send: true,
      });

      if (hash) {
        existingSporeRecord = {
          outPoint: {
            txHash: hash,
            index: BI.from(outputIndex).toHexString(),
          },
          account: ALICE,
        };
      }
    }, 60000);

    it('Melt and Create a Spore', async () => {
      expect(existingSporeRecord).toBeDefined();
      const sporeRecord = existingSporeRecord!;
      const sporeCell = await retryQuery(() => getSporeByOutPoint(sporeRecord.outPoint, config));
      const sporeOwner = sporeRecord.account;

      expect(existingClusterRecord).toBeDefined();
      const clusterRecord = existingClusterRecord!;
      const clusterCell = await retryQuery(() => getClusterByOutPoint(clusterRecord.outPoint, config));
      const clusterId = clusterCell.cellOutput.type!.args;
      const clsuterOwner = clusterRecord.account;

      const clusterOwnerCell = await retryQuery(() => getLiveCell(clsuterOwner, false));
      expect(clusterOwnerCell).toBeDefined();
      const { txSkeleton, outputIndex } = await meltThenCreateSpore({
        data: {
          contentType: 'dob/0',
          content: bytifyRawString('opened dob spore'),
          clusterId,
        },
        toLock: sporeOwner.lock,
        fromInfos: [sporeOwner.address],
        prefixInputs: [clusterOwnerCell!],
        prefixOutputs: [clusterOwnerCell!],
        outPoint: sporeCell.outPoint!,
        changeAddress: sporeOwner.address,
        config,
        feeRate: 3000,
      });

      txSkeleton.get('inputs').forEach((cell) => {
        expect(cell == clusterCell).toBeFalsy();
      });
      let snapshot = createCapacitySnapshotFromTransactionSkeleton(txSkeleton);
      expect(snapshot.inputsRemainCapacity.toNumber()).gt(0).lt(100000000);

      // const { hash } = await signAndOrSendTransaction({
      //   account: [sporeOwner, clsuterOwner],
      //   txSkeleton,
      //   config,
      //   rpc,
      //   send: true,
      // });

      // use another proper method to interactively sign message
      let signedTxSkeleton = common.prepareSigningEntries(txSkeleton, { config: config.lumos });
      // sign from client (seralize and send the result skeleton to the backend server)
      signedTxSkeleton = sporeOwner.signTransaction(signedTxSkeleton);
      // sign from server
      signedTxSkeleton = clsuterOwner.signTransaction(signedTxSkeleton);
      // send message
      const tx = helpers.createTransactionFromSkeleton(signedTxSkeleton);
      console.log('RPC Transaction:', JSON.stringify(ParamsFormatter.toRawTransaction(tx), null, 2));
      const hash = await rpc.sendTransaction(tx, 'passthrough');
      if (hash) {
        console.log('TransactionHash:', hash);
        SPORE_OUTPOINT_RECORDS.push({
          outPoint: {
            txHash: hash,
            index: BI.from(outputIndex).toHexString(),
          },
          account: sporeRecord.account,
        });
      }
    }, 90000);
  });
});
