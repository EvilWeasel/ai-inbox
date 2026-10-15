import { ActionInputValidationError } from '@agent-native/core/action';
import read from './actions/read';
import publish from './actions/publish';
import { ApiError } from '../items';
import { assertSameOrigin,assertTrustedHost,failure,json } from '../http';
// Next.js compatibility transport: invoke the framework's validated, authorized
// ActionDefinition boundary. UI and external agent HTTP calls share this registry.
export async function dispatch(request:Request,name:string) {
  try {
    assertTrustedHost(request);
    if(request.headers.has('origin'))assertSameOrigin(request);
    if(name==='read'&&request.method==='GET') {
      const params=new URL(request.url).searchParams;const input:Record<string,string>={};
      for(const [key,value] of params){if(key in input)throw new ApiError(400,'Duplicate query parameter');input[key]=value;}
      return json(await read.run(input,{caller:request.headers.has('authorization')?'http':'frontend',requestHeaders:request.headers}));
    }
    if(name==='publish'&&request.method==='POST') {
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new ApiError(415,'JSON required');
      const reader=request.body?.getReader();if(!reader)throw new ApiError(400,'JSON required');let size=0;const parts:Uint8Array[]=[];
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>128*1024){await reader.cancel();throw new ApiError(413,'Request too large');}parts.push(value);}}finally{reader.releaseLock();}
      let input:unknown;try{input=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new ApiError(400,'Invalid JSON');}
      return json(await publish.run(input as never,{caller:'http',requestHeaders:request.headers}),201);
    }
    throw new ApiError(404,'Unknown action');
  }catch(error){if(error instanceof ActionInputValidationError)return json({error:'Invalid input'},400);return failure(error);}
}
