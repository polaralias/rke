/** Rough byte proxy only; code and token-heavy text can exceed the estimated token count. */
export function fitBudget<T extends Record<string, unknown>>(payload:T,tokenBudget:number,arrays:string[]):T {
  const budget=Math.max(256,Math.min(16000,tokenBudget))*4-128;
  let omitted=0;
  const output:Record<string,unknown>={...payload,outputBudget:{estimatedTokens:0,tokenBudget,omittedItems:0,estimator:"rough UTF-8 bytes / 4 proxy; not a token upper bound"}};
  while(Buffer.byteLength(JSON.stringify(output))>budget){
    const key=arrays.filter(key=>Array.isArray(output[key])&&(output[key] as unknown[]).length||typeof output[key]==="string"&&(output[key] as string).length>80).sort((a,b)=>Buffer.byteLength(JSON.stringify(output[b]))-Buffer.byteLength(JSON.stringify(output[a])))[0];
    if(!key)break;
    output[key]=Array.isArray(output[key])?(output[key] as unknown[]).slice(0,-1):`${(output[key] as string).slice(0,Math.floor((output[key] as string).length/2))}\n[Output truncated]`;omitted++;
    output.truncated=true;
  }
  output.outputBudget={estimatedTokens:Math.ceil(Buffer.byteLength(JSON.stringify(output))/4),tokenBudget,omittedItems:omitted,estimator:"rough UTF-8 bytes / 4 proxy; not a token upper bound"};
  return output as T;
}
