import { dispatch } from '@/server/observatory/transport';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request,context:{params:Promise<{action:string}>}){return dispatch(request,(await context.params).action);}
export {handle as GET,handle as POST};
