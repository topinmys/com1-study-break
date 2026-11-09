import bcrypt from 'npm:bcryptjs@3.0.3';
import { createHandler } from './handler.js';
import { createRpc } from './transport.js';

const env = Deno.env.toObject();
const rpc = createRpc(env);
Deno.serve(createHandler({ rpc, comparePin: bcrypt.compare, env }));
