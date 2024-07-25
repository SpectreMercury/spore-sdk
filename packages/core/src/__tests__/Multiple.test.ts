import { BI } from '@ckb-lumos/lumos';
import { describe, it } from 'vitest';
import { createMultipleSpores, getSporeById, meltMultipleThenCreateSpore, transferMultipleSpore } from '../api';
import { predefinedSporeConfigs } from '../config';
import { bytifyRawString } from '../helpers';
import { signAndOrSendTransaction } from './helpers';
import { MultipleTestSPORE_OUTPOINT_RECORDS, TEST_ACCOUNTS, TEST_ENV } from './shared';

const options = {
  timeout: 10000000,
};
describe('Multiple', options, () => {
  const { rpc, config } = TEST_ENV;
  const { ALICE, BOB, CHARLIE } = TEST_ACCOUNTS;

  it('Create Multiple First', async () => {
    const createAmount = 2;
    const { txSkeleton, outputIndices } = await createMultipleSpores({
      sporeInfos: Array(createAmount).fill({
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('content'),
        },
        toLock: CHARLIE.lock,
      }),
      fromInfos: [CHARLIE.address],
      config,
    });
    const { hash } = await signAndOrSendTransaction({
      account: CHARLIE,
      txSkeleton,
      config,
      rpc,
      send: true,
    });

    if (hash) {
      for (const index of outputIndices) {
        MultipleTestSPORE_OUTPOINT_RECORDS.push({
          outPoint: {
            txHash: hash,
            index: BI.from(index).toHexString(),
          },
          account: CHARLIE,
          sporeId: txSkeleton.get('outputs').get(index)!.cellOutput.type!.args,
        });
      }
    }
  });
  it('Multiple Transfer', async () => {
    // wait for transaction success
    // dirty but works
    await new Promise((f) => setTimeout(f, 20000));
    const spore_cells = MultipleTestSPORE_OUTPOINT_RECORDS.map((spore) => spore.outPoint);
    const txSkeleton = await transferMultipleSpore({
      outPoints: spore_cells,
      fromInfos: [CHARLIE.address],
      toLock: ALICE.lock,
      config: predefinedSporeConfigs.Testnet,
    });

    const hash = await signAndOrSendTransaction({ account: CHARLIE, txSkeleton, config, rpc, send: true });
    console.log(`Spore Multiple Transfer at: https://pudge.explorer.nervos.org/transaction/${hash.hash}`);
    //console.log(`Spore ID: ${txSkeleton.get('outputs').get(outputIndex)!.cellOutput.type!.args}`);
  }),
    it('Multiple Melt Then Create One', async () => {
      // wait for transaction success
      // dirty but works
      await new Promise((f) => setTimeout(f, 20000));
      const sporeIds = MultipleTestSPORE_OUTPOINT_RECORDS.map((spore) => spore.sporeId);
      const sporeCells = (
        await Promise.all(
          sporeIds.map(async (spore_id) => {
            const sporeData = await getSporeById(spore_id, predefinedSporeConfigs.Testnet);
            return sporeData?.outPoint;
          }),
        )
      ).filter((outPoint) => outPoint !== undefined);

      const { txSkeleton } = await meltMultipleThenCreateSpore({
        outPoints: sporeCells,
        fromInfos: [ALICE.address],
        toLock: BOB.lock,
        config: predefinedSporeConfigs.Testnet,
        data: {
          contentType: 'text/plain',
          content: bytifyRawString('content'),
        },
      });
      const hash = await signAndOrSendTransaction({ account: ALICE, txSkeleton, config, rpc, send: true });
      console.log(`Spore created at: https://pudge.explorer.nervos.org/transaction/${hash.hash}`);
      //console.log(`Spore ID: ${txSkeleton.get('outputs').get(outputIndex)!.cellOutput.type!.args}`);
    });
});
