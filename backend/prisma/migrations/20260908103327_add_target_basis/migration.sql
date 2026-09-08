-- CreateEnum
CREATE TYPE "TargetBasis" AS ENUM ('PIVOT', 'ATR');

-- AlterTable
ALTER TABLE "TradeSignal" ADD COLUMN     "targetBasis" "TargetBasis";
