// Génère l'empreinte du mot de passe admin (le mot de passe lui-même n'est jamais stocké).
//   npm run hash-password                -> affiche la valeur à coller dans Netlify (variable ADMIN_PASSWORD_HASH)
//   npm run hash-password -- --generate  -> génère aussi un mot de passe fort aléatoire
//   npm run hash-password -- --local     -> écrit aussi la valeur dans .env pour le serveur local
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 16384;

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.includes(question) || s === '\r\n' || s === '\n' ? s : '*');
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

let password;
if (process.argv.includes('--generate')) {
  password = crypto.randomBytes(18).toString('base64url');
  console.log(`\nVotre mot de passe : ${password}\nNotez-le dans un gestionnaire de mots de passe : il ne sera plus affiché.\n`);
} else {
  password = await askHidden('Nouveau mot de passe (12 caractères minimum) : ');
  if (password.length < 12) {
    console.error('Trop court : 12 caractères minimum.');
    process.exit(1);
  }
  if ((await askHidden('Confirmez : ')) !== password) {
    console.error('Les deux saisies ne correspondent pas.');
    process.exit(1);
  }
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64, { N, r: 8, p: 1 });
const value = `scrypt:${N}:${salt.toString('hex')}:${hash.toString('hex')}`;

console.log('Dans Netlify : Site configuration > Environment variables > Add a variable');
console.log('  Key   : ADMIN_PASSWORD_HASH');
console.log(`  Value : ${value}\n`);

if (process.argv.includes('--local')) {
  fs.writeFileSync(path.join(ROOT, '.env'), `ADMIN_PASSWORD_HASH=${value}\n`);
  console.log('Valeur aussi enregistrée dans .env pour le serveur local (npm run dev).');
}
