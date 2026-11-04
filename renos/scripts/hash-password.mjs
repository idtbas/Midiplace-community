#!/usr/bin/env node
/**
 * Erzeugt einen scrypt-Hash für das Owner-Passwort von RenOS.
 *
 *   npm run hash-password
 *
 * Das Passwort wird verdeckt abgefragt (oder per Umgebungsvariable RENOS_PASSWORD übergeben)
 * und niemals gespeichert. Den ausgegebenen Hash in `.env` als RENOS_OWNER_PASSWORD_HASH eintragen.
 */
import { randomBytes, scrypt } from 'node:crypto';
import readline from 'node:readline';

const N = 2 ** 15;
const r = 8;
const p = 1;

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (text) => {
      if (text.includes(question)) write?.(text);
      else write?.('*');
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

let password = process.env.RENOS_PASSWORD;
if (!password) {
  password = await ask('Neues Owner-Passwort: ');
  const repeat = await ask('Passwort wiederholen: ');
  if (password !== repeat) {
    console.error('Die Passwörter stimmen nicht überein.');
    process.exit(1);
  }
}
if (password.length < 8) {
  console.error('Das Passwort muss mindestens 8 Zeichen lang sein.');
  process.exit(1);
}

const salt = randomBytes(16);
scrypt(password, salt, 64, { N, r, p, maxmem: 128 * N * r * 2 }, (error, key) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  const hash = ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
  console.log('\nIn .env eintragen:\n');
  console.log(`RENOS_OWNER_PASSWORD_HASH=${hash}\n`);
});
