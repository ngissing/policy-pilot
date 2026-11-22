// Give an account a one-time password, for when nobody who could reset it can sign in.
// Usage (on the server, e.g. in a Railway shell):  npm run reset-password -- someone@school.vic.edu.au
import { one, run } from "../server/db.ts";
import { hashPassword, temporaryPassword } from "../server/auth.ts";

const email = (process.argv[2] ?? "").trim();
if (!email) {
  console.error("Give the account's email address, e.g. npm run reset-password -- someone@school.vic.edu.au");
  process.exit(1);
}
const user = one<{ id: number; name: string }>("SELECT id, name FROM users WHERE email = ?", email);
if (!user) {
  console.error(`No account uses ${email}.`);
  process.exit(1);
}
const password = temporaryPassword();
run("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", hashPassword(password), user.id);
run("DELETE FROM sessions WHERE user_id = ?", user.id);
console.log(`One-time password for ${user.name}: ${password}`);
console.log("They'll be asked to choose their own password when they sign in.");
