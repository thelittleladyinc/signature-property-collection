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
