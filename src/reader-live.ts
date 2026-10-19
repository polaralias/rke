import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { renderReader, validateReaderProjection, type ReaderProjection } from "./reader.js";

export interface LiveReader {
  url:string;
  close():Promise<void>;
}
export interface LiveReaderSource {
  /** Host-owned closures capture fixed request arguments and physical root pins. */
  validate():void;
  read():Promise<ReaderProjection>;
}
const sessions=new Set<LiveReader>(),MAX_SESSIONS=8,IDLE_MS=10*60*1000;
const REFRESH_CLIENT='document.getElementById("refresh-snapshot").addEventListener("click",event=>{event.preventDefault();location.reload();});';
const REFRESH_HASH=createHash("sha256").update(REFRESH_CLIENT).digest("base64");
let starting=0;
let ending=false;

/** Only one authenticated page route; HTTP data never selects a root, path or command. */
export async function startLiveReader(source:LiveReaderSource):Promise<LiveReader>{
  if(ending)throw new Error("reader_live_transport_ended");
  if(sessions.size+starting>=MAX_SESSIONS)throw new Error("reader_live_session_limit");
  source.validate();
  const token=randomBytes(32).toString("hex"),secret=Buffer.from(token),server=createServer({maxHeaderSize:8192});
  let authority="",origin="",busy=false,stopped=false,timer:NodeJS.Timeout|undefined,closing:Promise<void>|undefined,inFlight:Promise<void>|undefined;
  const reply=(response:ServerResponse,status:number,body:string,html=false)=>{
    response.writeHead(status,{"Content-Type":html?"text/html; charset=utf-8":"text/plain; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Cross-Origin-Opener-Policy":"same-origin","Content-Security-Policy":html?(/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(body)![1]+"; frame-ancestors 'none'"):"default-src 'none'; frame-ancestors 'none'"});
    response.end(body);
  };
  const arm=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>{void session.close();},IDLE_MS);timer.unref();};
  const permitted=(request:IncomingMessage)=>{
    if(request.method!=="GET"||request.headers.host!==authority||request.headers.origin!==undefined&&request.headers.origin!==origin)return false;
    const site=request.headers["sec-fetch-site"];if(site!==undefined&&site!=="same-origin"&&site!=="none")return false;
    if(!request.url||request.url.length>1024)return false;
    const url=new URL(request.url,origin);
    if(url.origin!==origin||url.pathname!=="/"||url.hash||[...url.searchParams.keys()].some(key=>key!=="session")||url.searchParams.getAll("session").length!==1)return false;
    const supplied=Buffer.from(url.searchParams.get("session")!);return supplied.length===secret.length&&timingSafeEqual(supplied,secret);
  };
  server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
  server.on("request",(request,response)=>{
    let allowed=false;try{allowed=permitted(request);}catch{/* Invalid request remains a refusal without source access. */}
    if(!allowed){reply(response,403,"Reader request refused.");return;}
    if(stopped){reply(response,410,"Reader session ended.");return;}
    if(busy){reply(response,429,"Reader refresh is already running.");return;}
    busy=true;arm();
    inFlight=(async()=>{
      try{
        source.validate();const projection=await source.read();source.validate();validateReaderProjection(projection);
        if(stopped||response.destroyed)return;
        const html=renderReader(projection).replace("</header>",`<a id="refresh-snapshot" href="/?session=${token}">Refresh snapshot</a></header>`).replace("script-src ",`script-src 'sha256-${REFRESH_HASH}' `).replace("</body>",`<script>${REFRESH_CLIENT}</script></body>`);
        reply(response,200,html,true);
      }catch{if(!stopped&&!response.destroyed)reply(response,409,"Current reader evidence is unavailable. Refresh after resolving its source or root change.");}
      finally{busy=false;}
    })();
  });
  const session:LiveReader={url:"",close(){
    if(closing)return closing;
    stopped=true;if(timer)clearTimeout(timer);
    const transportClosed=new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
    closing=Promise.all([transportClosed,inFlight]).then(()=>{sessions.delete(session);});return closing;
  }};
  starting++;
  try{await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.removeListener("error",reject);resolve();});});}finally{starting--;}
  const address=server.address();if(!address||typeof address==="string")throw new Error("reader_live_address_unavailable");
  if(ending){await session.close();throw new Error("reader_live_transport_ended");}
  authority=`127.0.0.1:${address.port}`;origin=`http://${authority}`;session.url=`${origin}/?session=${token}`;
  sessions.add(session);arm();return session;
}

/** Transport lifecycle closes only sessions started by this process. */
export async function closeLiveReaders():Promise<void>{await Promise.all([...sessions].map(session=>session.close()));}
export async function endLiveReaders():Promise<void>{ending=true;await closeLiveReaders();}
