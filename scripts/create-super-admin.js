// Creates a super admin, or promotes an existing user to super admin.
//
//   npm run create-admin -- you@example.com "Your Name"
//
// The password is asked in the terminal (hidden) and only for a new user;
// an existing user keeps theirs. Uses the database from .env.
import readline from 'readline';
import bcrypt from 'bcrypt';
import { sequelize } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { addSuggestedCategories } from '../src/utils/categoryCatalog.js';
import { isAcceptablePassword } from '../src/utils/password.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Print the question, then hide what is typed.
    process.stdout.write(question);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const [email, ...nameParts] = process.argv.slice(2);
  if (!email || !email.includes('@')) {
    console.error('Usage: npm run create-admin -- <email> ["Full name"]');
    process.exit(1);
  }

  const existing = await User.findOne({ where: { email } });
  if (existing) {
    await existing.update({ isSuperAdmin: true, isActive: true, isEmailVerified: true });
    console.log(`${email} is now a super admin (password unchanged).`);
    return;
  }

  const password = await askHidden('Password (8+ characters): ');
  if (!isAcceptablePassword(password)) {
    console.error('Password must be 8 to 72 characters.');
    process.exit(1);
  }
  if ((await askHidden('Repeat the password: ')) !== password) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const user = await User.create({
    name: nameParts.join(' ') || email.split('@')[0],
    email,
    passwordHash: await bcrypt.hash(password, 10),
    isEmailVerified: true,
    isActive: true,
    isSuperAdmin: true,
    language: 'es',
  });
  await addSuggestedCategories(user.id, user.language).catch(() => {});
  console.log(`Super admin ${email} created.`);
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
