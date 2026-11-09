// local helper for choosing a private organiser pin; this file contains no real event pin.
import { createInterface } from 'node:readline/promises';
import bcrypt from 'bcryptjs';
// avoid arguments/env vars, which can leak through history or process listings.
if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal.');
// read the pin interactively and suppress terminal echo.
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log('Choose a random 6–12 digit organiser PIN. Input is hidden.');
rl._writeToOutput = () => {};
const pin = await rl.question('');
rl.close();
if (!/^\d{6,12}$/.test(pin)) throw new Error('PIN must contain 6–12 digits.');
// print the bcrypt hash for private server settings; never print the usable pin.
console.log('\nORGANISER_PIN_HASH=' + (await bcrypt.hash(pin, 12)));
