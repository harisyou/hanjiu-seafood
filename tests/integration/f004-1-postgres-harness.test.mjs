import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const url = process.env.F004_1_TEST_DATABASE_URL;
const enabled = process.env.F004_1_ALLOW_DATABASE_TESTS === "1";
const fixture = {
  variantId: process.env.F004_1_TEST_VARIANT_ID,
  customerName: process.env.F004_1_TEST_CUSTOMER_NAME || "F004-1 integration customer",
  phone: process.env.F004_1_TEST_PHONE || "0912345678"
};
const preorderFixture = {
  variantId: process.env.F004_3_3_TEST_PREORDER_VARIANT_ID,
  customerName: process.env.F004_3_3_TEST_CUSTOMER_NAME || "F004-3.3 preorder integration customer",
  phone: process.env.F004_3_3_TEST_PHONE || "0912345678"
};
const preorderEnabled = process.env.F004_3_3_ALLOW_DATABASE_TESTS === "1";

function psql(sql) {
  return spawnSync("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { encoding: "utf8" });
}

function psqlConcurrent(sql) {
  return new Promise((resolve) => {
    const child = spawn("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("PostgreSQL: concurrent same-key checkout creates one order and one movement", { skip: !enabled || !url || !fixture.variantId }, async () => {
  const keyResult = psql("select gen_random_uuid()");
  assert.equal(keyResult.status, 0, keyResult.stderr);
  const key = keyResult.stdout.trim();
  const payload = `jsonb_build_array(jsonb_build_object('variant_id', '${fixture.variantId}'::uuid, 'quantity', 1, 'processing_option_ids', '[]'::jsonb))`;
  const call = `select public.create_checkout_order('${fixture.customerName.replace(/'/g, "''")}', '${fixture.phone}', '永春市場自取', null, ${payload}, null, '${key}'::uuid)`;
  const [first, second] = await Promise.all([psqlConcurrent(call), psqlConcurrent(call)]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout.trim(), second.stdout.trim());
  const orderId = first.stdout.trim();
  const counts = psql(`select (select count(*) from public.orders where id = '${orderId}'::uuid), (select count(*) from public.order_items where order_id = '${orderId}'::uuid), (select count(*) from public.inventory_movements where order_id = '${orderId}'::uuid and movement_type = 'checkout_sale')`);
  assert.equal(counts.status, 0, counts.stderr);
  assert.equal(counts.stdout.trim(), "1|1|1");
});

test("PostgreSQL: preorder checkout records an immutable preorder item without inventory or ledger mutation", { skip: !preorderEnabled || !url || !preorderFixture.variantId }, () => {
  const keyResult = psql("select gen_random_uuid()");
  assert.equal(keyResult.status, 0, keyResult.stderr);
  const key = keyResult.stdout.trim();
  const before = psql(`select inventory from public.product_variants where id = '${preorderFixture.variantId}'::uuid`);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.stdout.trim(), "0", "fixture must be an active preorder variant with zero real stock");
  const payload = `jsonb_build_array(jsonb_build_object('variant_id', '${preorderFixture.variantId}'::uuid, 'quantity', 2, 'supply_type', 'preorder', 'processing_option_ids', '[]'::jsonb))`;
  const call = `select public.create_checkout_order('${preorderFixture.customerName.replace(/'/g, "''")}', '${preorderFixture.phone}', '永春市場自取', null, ${payload}, null, '${key}'::uuid)`;
  const created = psql(call);
  assert.equal(created.status, 0, created.stderr);
  const orderId = created.stdout.trim();
  const facts = psql(`select (select inventory from public.product_variants where id = '${preorderFixture.variantId}'::uuid), (select count(*) from public.order_items where order_id = '${orderId}'::uuid and supply_type = 'preorder'), (select count(*) from public.inventory_movements where order_id = '${orderId}'::uuid)`);
  assert.equal(facts.status, 0, facts.stderr);
  assert.equal(facts.stdout.trim(), "0|1|0");
});
