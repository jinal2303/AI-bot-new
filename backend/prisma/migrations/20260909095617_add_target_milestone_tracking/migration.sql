-- AlterTable
ALTER TABLE "TradeSignal" ADD COLUMN     "initialTargetSpot" DOUBLE PRECISION,
ADD COLUMN     "lastNotifiedMilestonePct" INTEGER NOT NULL DEFAULT 0;
