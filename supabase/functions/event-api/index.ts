// entry point for the single deployed edge function.
import bcrypt from 'npm:bcryptjs@3.0.3';
import { createHandler } from './handler.js';
import { createRpc } from './transport.js';

// read private runtime settings supplied by supabase, not by the browser.
const env = Deno.env.toObject();
// connect the database transport to the request handler.
const rpc = createRpc(env);
// deno is the javascript runtime that receives requests in this hosted edge function.
Deno.serve(createHandler({ rpc, comparePin: bcrypt.compare, env }));
