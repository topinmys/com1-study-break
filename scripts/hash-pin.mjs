import { createInterface } from 'node:readline/promises';
import bcrypt from 'bcryptjs';
// Avoid arguments/env vars, which can leak through history or process listings.
if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log('Choose a random 6–12 digit organiser PIN. Input is hidden.');
rl._writeToOutput = () => {};
const pin = await rl.question('');
rl.close();
if (!/^\d{6,12}$/.test(pin)) throw new Error('PIN must contain 6–12 digits.');
console.log('\nORGANISER_PIN_HASH=' + await bcrypt.hash(pin, 12));
