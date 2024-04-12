import { describe, expect, it, afterAll } from 'vitest';
import { BI, Cell, Indexer } from '@ckb-lumos/lumos';
import { getSporeScript } from '../config';
import { bufferToRawString, bytifyRawString, getCellByLock } from '../helpers';
import {
  createSpore,
  transferSpore,
  meltSpore,
  getSporeByOutPoint,
  createCluster,
  getClusterByOutPoint,
  createMultipleSpores,
} from '../api';
import { expectCellDep, expectTypeId, expectTypeCell, expectCellLock, Account } from './helpers';
import { getSporeOutput, popRecord, retryQuery, signAndOrSendTransaction, OutPointRecord } from './helpers';
import { TEST_ACCOUNTS, TEST_ENV, SPORE_OUTPOINT_RECORDS, cleanupRecords } from './shared';
import { meltThenCreateSpore } from '../api/composed/spore/meltThenCreateSpore';
import { SporeAction, WitnessLayout } from '../cobuild';

describe('Spore', () => {
  const { rpc, config } = TEST_ENV;
  const { CHARLIE, ALICE, BOB } = TEST_ACCOUNTS;

  async function getLiveCell(account: Account): Promise<Cell | undefined> {
    const indexer = new Indexer(config.ckbIndexerUrl);
    return getCellByLock({
      lock: account.lock,
      indexer,
    });
  }

  afterAll(async () => {
    await cleanupRecords({
      name: 'Spore',
    });
  }, 0);

  describe('Spore basics', () => {
    let existingSporeRecord: OutPointRecord | undefined;
    it('Create a Spore', async () => {
      const capacityCell = await getLiveCell(CHARLIE);
      const { txSkeleton, outputIndex, reference } = await createSpore({
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('content'),
        },
        toLock: CHARLIE.lock,
        fromInfos: [],
        extraInputCells: [capacityCell!],
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
          content: bytifyRawString('blind box spore'),
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

      expect(existingClusterRecord).toBeDefined();
      const clusterRecord = existingClusterRecord!;
      const clusterCell = await retryQuery(() => getClusterByOutPoint(clusterRecord.outPoint, config));
      const clusterId = clusterCell.cellOutput.type!.args;

      const clusterOwnerCell = await getLiveCell(BOB);
      const { txSkeleton, outputIndex } = await meltThenCreateSpore({
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('dob spore'),
          clusterId,
        },
        toLock: ALICE.lock,
        fromInfos: [ALICE.address],
        extraInputCells: [clusterOwnerCell!],
        extraOutputCells: [clusterOwnerCell!],
        outPoint: sporeCell.outPoint!,
        changeAddress: ALICE.address,
        config,
      });

      txSkeleton.get('inputs').forEach((cell) => {
        expect(cell == clusterCell).toBeFalsy();
      });

      const { txSkeleton: aliceSignedTxSkeleton } = await signAndOrSendTransaction({
        account: ALICE,
        txSkeleton,
        config,
        send: false,
      });
      const { hash } = await signAndOrSendTransaction({
        account: BOB,
        txSkeleton: aliceSignedTxSkeleton,
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
          account: ALICE,
        });
      }
    }, 90000);
  });
});
