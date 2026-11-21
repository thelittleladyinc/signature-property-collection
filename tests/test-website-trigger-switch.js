'use strict';
// Verify BOTH flag states without contacting Lofty; no emails, forms or network.
// The replay module is required in a clean Node process for each env state.
const {spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const cli="const L=require('./netlify/functions/lib/_lofty'); const N=require('./netlify/functions/lib/_notify'); process.stdout.write(JSON.stringify({tag:L.REPLAY_TRIGGER_TAG,brand:N.BRAND_SITE}));";
function check(flag){
 const o=spawnSync(process.execPath,['-e',cli],{cwd:root,encoding:'utf8',timeout:10000,env:{...process.env,LITTLE_LADY_WEBSITE_TRIGGER:flag}});
 assert.equal(o.status,0,o.stderr||'Child did not run');
 return JSON.parse(o.stdout);
}
const normal=check('off'), optIn=check('on'), other=check('yes');
assert.equal(normal.tag,'Hot Lead - Website');
assert.equal(other.tag,'Hot Lead - Website');
assert.equal(normal.brand,'signature');
assert.equal(optIn.tag,'Hot Lead - Website');
const handler=fs.readFileSync(path.join(root,'netlify/functions/submission-created.js'),'utf8');
if(normal.brand==='tllsh'){
 assert.ok(handler.includes('LITTLE_LADY_WEBSITE_TRIGGER_ON ? "Source – Little Lady Website" : "Hot Lead - Website"'));
 assert.ok(handler.includes('if (LITTLE_LADY_WEBSITE_TRIGGER_ON) body.tags.push("Hot Lead - Website")'));
 assert.ok(handler.includes('body.tags = [TRIGGER_TAG, "Website Lead", formName]'));
}else{
 assert.ok(handler.includes('const TRIGGER_TAG = "Hot Lead - Website"'));
}
console.log('All checks passed.');
