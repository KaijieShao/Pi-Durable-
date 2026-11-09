import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Linux retention: real same-device bind alias and attached loop image are retained before deletion", {
	skip:
		process.platform !== "linux" || process.getuid?.() !== 0 || process.env.PI_RETENTION_LINUX_TESTS !== "1"
			? "requires explicit PI_RETENTION_LINUX_TESTS=1 and root on the isolated Linux test VM"
			: false,
	timeout: 120_000,
}, () => {
	const moduleUrl = new URL("../../src/maintenance/retention.ts", import.meta.url).href;
	const script = `
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import {retainBundles} from ${JSON.stringify(moduleUrl)};
const root=await realpath(await mkdtemp('/tmp/pi-retention-linux-'));
const candidate=join(root,'candidate'),alias=join(root,'alias');
for(const p of [candidate,alias])await mkdir(p);
await writeFile(join(candidate,'kept.txt'),'kept');
const policy={roots:[root],protectedPaths:[join(root,'task-8'),join(root,'task-9')],retentionMs:{trial:86400000,'test-artifact':86400000,archive:86400000,'raw-trial-store':86400000},bundles:[{path:candidate,kind:'test-artifact',completedAt:0,reportPreserved:true,pinned:false}]};
let mounted=false,loop;
const exec=(args)=>execFileSync(args[0],args.slice(1),{encoding:'utf8',timeout:10000}).trim();
try {
 exec(['mount','--bind',candidate,alias]);mounted=true;
 const bound=await retainBundles(policy,Date.now(),true);
 assert.equal(bound[0].outcome,'kept');assert.equal(bound[0].reason,'attached');
 assert.equal(await readFile(join(candidate,'kept.txt'),'utf8'),'kept');
 exec(['umount',alias]);mounted=false;
 const image=join(candidate,'disposable.img'),file=await open(image,'w');await file.truncate(4*1024*1024);await file.close();
 loop=exec(['losetup','--find','--show',image]);assert.match(loop,/^\\/dev\\/loop\\d+$/);
 const attached=await retainBundles(policy,Date.now(),true);
 assert.equal(attached[0].outcome,'kept');assert.equal(attached[0].reason,'attached');
 exec(['losetup','-d',loop]);loop=undefined;
 const detached=await retainBundles(policy,Date.now(),true);
 assert.equal(detached[0].outcome,'deleted');
 console.log(JSON.stringify({same_device_bind_retained:true,loop_backing_image_retained:true,detached_disposable_deleted:true}));
} finally {
 if(loop)exec(['losetup','-d',loop]);
 if(mounted)exec(['umount',alias]);
 await rm(root,{recursive:true,force:true});
}
`;
	const result = spawnSync(
		"unshare",
		["--mount", "--propagation", "private", process.execPath, "--input-type=module", "-e", script],
		{
			encoding: "utf8",
			timeout: 100_000,
			env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"same_device_bind_retained":true/);
	assert.match(result.stdout, /"loop_backing_image_retained":true/);
	assert.match(result.stdout, /"detached_disposable_deleted":true/);
});
