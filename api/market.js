// api/market.js — دریافت قیمت زنده از tsetmc (در صورت امکان دسترسی)
const SYM=['فولاد','فملی','شبندر','شپنا','شتران','وبملت','وتجارت','شپدیس','شکبیر','سشرق','سپاها','دفارا','وخارزم','تاپیکو','فخوز','بترابر'];
let cache=null,ct=0;
const num=v=>typeof v==='number'?v:parseFloat(v);
async function jget(u,ms=6500){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);
  try{const r=await fetch(u,{signal:c.signal,headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json,text/plain,*/*'}});
    clearTimeout(t);if(!r.ok)throw new Error('http '+r.status);return await r.json()}
  catch(e){clearTimeout(t);throw e}}
async function parlist(){
  if(cache&&Date.now()-ct<6*3600e3)return cache;
  const j=await jget('https://cdn.tsetmc.com/api/ParList/GetParList');
  const arr=(j&&j.parList)||j||[];const m={};
  arr.forEach(p=>{const s=String(p.lVal18||'').trim();if(SYM.includes(s)&&p.insCode)m[s]=p.insCode});
  if(!Object.keys(m).length)throw new Error('parlist empty');
  cache=m;ct=Date.now();return m}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  try{
    const par=await parlist();const prices={};
    await Promise.all(Object.keys(par).map(async s=>{
      try{
        const j=await jget('https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDaily/'+par[s]);
        const list=Array.isArray(j)?j:((j&&j.closingPriceDaily)||[]);
        if(list&&list.length){const L=list[list.length-1];
          const close=num(L.pDrCotVal!=null?L.pDrCotVal:L.price);
          let ch=num(L.priceChange);
          const prev=num(L.priceYesterday!=null?L.priceYesterday:L.pDrCotValYesterday);
          if(!isFinite(ch)&&isFinite(close)&&isFinite(prev)&&prev>0)ch=(close/prev-1)*100;
          if(isFinite(close)&&close>0&&isFinite(ch))prices[s]={p:close,d:Math.round(ch*100)/100}}
      }catch(e){}}));
    if(Object.keys(prices).length)res.status(200).json({ok:true,n:Object.keys(prices).length,prices,t:Date.now()});
    else res.status(200).json({ok:false,reason:'no-price'});
  }catch(e){res.status(200).json({ok:false,reason:'unreachable'})}}
