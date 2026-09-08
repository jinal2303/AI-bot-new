-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('CALL', 'PUT');

-- CreateEnum
CREATE TYPE "ExpiryType" AS ENUM ('CURRENT_WEEK', 'NEXT_WEEK');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('ACTIVE', 'TARGET_HIT', 'STOPLOSS_HIT');

-- CreateTable
CREATE TABLE "TradeSignal" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateString" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "strikePrice" DOUBLE PRECISION NOT NULL,
    "expiryType" "ExpiryType" NOT NULL,
    "entrySpotPrice" DOUBLE PRECISION NOT NULL,
    "stopLossSpot" DOUBLE PRECISION NOT NULL,
    "targetSpot" DOUBLE PRECISION NOT NULL,
    "currentStatus" "TradeStatus" NOT NULL DEFAULT 'ACTIVE',
    "resolvedAt" TIMESTAMP(3),
    "resolvedSpot" DOUBLE PRECISION,

    CONSTRAINT "TradeSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradeSignal_dateString_idx" ON "TradeSignal"("dateString");

-- CreateIndex
CREATE INDEX "TradeSignal_currentStatus_idx" ON "TradeSignal"("currentStatus");

-- CreateIndex
CREATE INDEX "TradeSignal_direction_idx" ON "TradeSignal"("direction");

-- CreateIndex
CREATE INDEX "TradeSignal_expiryType_idx" ON "TradeSignal"("expiryType");

-- CreateIndex
CREATE INDEX "TradeSignal_dateString_currentStatus_idx" ON "TradeSignal"("dateString", "currentStatus");

-- CreateIndex
CREATE INDEX "TradeSignal_timestamp_idx" ON "TradeSignal"("timestamp");
