const test=require("node:test"); const assert=require("node:assert/strict");
const {requestedAlert,activatePropertyAlert,PROPERTY_TYPES}=require("../netlify/functions/lib/_listing-alerts");
const data={listing_alert_consent:"yes",email:"buyer@example.test",alert_city:"Loveland",alert_max_price:"600000",alert_beds:"3",alert_baths:"1.5",alert_property_type:"Vacant Land"};
test("explicit structured opt-in keeps exact filters and rejects bad or unsupported criteria",()=>{
  assert.equal(requestedAlert({}),null);
  assert.deepEqual(requestedAlert(data),{locations:{cities:["Loveland, CO"]},priceMax:600000,bedsMin:3,bathsMin:1.5,propertyTypes:["Vacant Land"]});
  for(const patch of [{alert_city:""},{alert_max_price:"abc"},{alert_min_price:"700000"},{alert_property_type:"Land"}]) assert.equal(requestedAlert({...data,...patch}),null);
  assert.ok(PROPERTY_TYPES.includes("Commercial"));
});
test("only this alert form with explicit consent can activate a Lofty alert",async()=>{
  let count=0;const fetch=async()=>{count++;throw Error("must not call");};
  assert.deepEqual(await activatePropertyAlert({formName:"contact",data,leadId:"123",submissionId:"s-1"},{fetch}),{attempted:false});
  assert.deepEqual(await activatePropertyAlert({formName:"listing-alert-request",data:{email:data.email},leadId:"123",submissionId:"s-1"},{fetch}),{attempted:false});
  assert.equal((await activatePropertyAlert({formName:"listing-alert-request",data,leadId:9007199254740994,submissionId:"s-1"},{fetch})).status,"held");
  assert.equal(count,0);
});
test("hub activation uses header-only auth, no redirect or own Lofty key, and reports failures honestly",async()=>{
  const calls=[];const env={HUB_API_URL:"https://hub.example.test",HUB_API_KEY:"hub_"+"a".repeat(64)};
  const opts={env,fetch:async(url,init)=>{calls.push({url,init});return{status:200,text:async()=>JSON.stringify({status:"active",copy_to_agent:true,search_id:"456"})};}};
  let result=await activatePropertyAlert({formName:"listing-alert-request",data,leadId:"123",submissionId:"s-1"},opts);
  assert.equal(result.status,"active");assert.equal(result.copyToAgent,true);
  assert.equal(calls[0].url,"https://hub.example.test/v1/lofty/property-alert");assert.equal(calls[0].init.redirect,"error");
  assert.equal(calls[0].init.headers["x-hub-key"],env.HUB_API_KEY);
  const body=JSON.parse(calls[0].init.body);assert.equal(body.requested,true);assert.equal(body.request_id,"s-1");assert.equal(body.email,data.email);
  result=await activatePropertyAlert({formName:"listing-alert-request",data,leadId:"123",submissionId:"s-1"},{env,fetch:async()=>({status:503,text:async()=>'{"error":"unavailable"}'})});
  assert.equal(result.status,"failed");assert.equal(result.retryable,true);
});

test("a transient alert failure retries only setup, preserving the accepted lead and avoiding repeated plans",async()=>{
  const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../netlify/functions/lib/_lofty.js"),"utf8");
  const fail=()=>{throw Error("contact, note, task or plan must not repeat");};let setupCalls=0;let transient=false;
  const sandbox={module:{exports:{}},exports:{},process:{env:{LOFTY_VIA_HUB:"on"}},Date,AbortSignal,setTimeout,clearTimeout,
    console:{log(){},warn(){},error(){}},require:name=>{
      if(name==="crypto")return require("node:crypto");
      if(name==="./_lofty-consent")return{applyTextingPreference:fail};
      if(name==="./_lofty-returning")return{leadIdFromResponse:fail,findExistingLead:fail,alertReturningLead:fail,ensureWebsiteFields:fail,setWebsiteFields:fail,websiteFieldValues:fail,inquiryFromForm:()=>null,placeInquiry:fail};
      if(name==="./_notify")return{addLoftyNote:fail,refireLoftyTag:fail,addPlanTags:fail,BRAND_SITE:"main"};
      if(name==="./_lofty-hub")return{loftyViaHub:()=>true,pushLeadViaHub:fail,confirmCreated:fail,hubExtraResult:fail};
      if(name==="./_form-plans")return{WEBSITE_SOURCE:"Website"};
      if(name==="./_listing-alerts")return{activatePropertyAlert:async()=>{setupCalls++;return transient?{status:"failed",retryable:true}:{status:"active",copyToAgent:true};}};
      throw Error("unexpected dependency "+name);
    }};
  vm.runInNewContext(source,sandbox);const L=sandbox.module.exports;
  const rows={};const store={get:async k=>rows[k]??null,setJSON:async(k,v)=>{rows[k]=v;return{modified:true};},delete:async k=>{delete rows[k];}};
  const result={ok:true,viaHub:true,site:"main",submissionId:"s-1",formData:data,propertyAlert:{status:"failed",retryable:true},propertyAlertLeadId:"123"};
  await L.recordPush(store,result,"listing-alert-request",{emails:[data.email]});
  assert.equal(rows[L.FAILED_PUSH_KEY].length,1);
  let r=await L.drainFailedPushes(store,null,{deadline:Date.now()+30000});
  assert.equal(r.finished,1);assert.equal(rows[L.FAILED_PUSH_KEY].length,0);assert.equal(setupCalls,1);
  transient=true;await L.recordPush(store,result,"listing-alert-request",{emails:[data.email]});
  r=await L.drainFailedPushes(store,null,{deadline:Date.now()+30000});
  assert.equal(rows[L.FAILED_PUSH_KEY].length,1);assert.deepEqual(Array.from(rows[L.FAILED_PUSH_KEY][0].followupsPending),["propertyAlert"]);
  assert.equal(Object.keys(rows[L.FAILED_PUSH_KEY][0].replay.steps).length,0);
});
