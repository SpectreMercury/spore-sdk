import { assert, describe, expect, it } from 'vitest';
import {
  OutPointRecord,
  expectCellDep,
  expectTypeCell,
  expectTypeId,
  getSporeOutput,
  retryQuery,
  signAndOrSendTransaction,
} from './helpers';
import { createCluster, createSpore, getClusterByOutPoint, getSporeByOutPoint } from '../api';
import { BI } from '@ckb-lumos/lumos';
import { bytifyRawString } from '../helpers';
import { meltThenCreateSpore } from '../api/composed/spore/meltThenCreateSpore';
import { SPORE_OUTPOINT_RECORDS, TEST_ACCOUNTS, TEST_ENV } from './shared';

describe.skip('Spore melt and mint in one transaction', () => {
  let existingSporeRecord: OutPointRecord | undefined;
  let existingClusterRecord: OutPointRecord | undefined;

  const { rpc, config } = TEST_ENV;
  const { CHARLIE, ALICE, BOB } = TEST_ACCOUNTS;

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
      if (cell == clusterCell) {
        assert(false, 'cluster cell should not appear in inputs');
      }
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
function getLiveCell(BOB: any) {
  throw new Error('Function not implemented.');
}
