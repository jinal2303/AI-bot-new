-- CreateEnum
CREATE TYPE "TrailStage" AS ENUM ('NONE', 'BREAKEVEN', 'PROFIT_LOCK');

-- AlterTable
ALTER TABLE "TradeSignal" ADD COLUMN     "staleAdjusted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trailStage" "TrailStage" NOT NULL DEFAULT 'NONE';
