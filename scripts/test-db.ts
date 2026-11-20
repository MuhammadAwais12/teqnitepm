import { prisma } from "../src/lib/prisma";

async function main() {
  await prisma.$connect();
  console.log("Neon database connected successfully!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
