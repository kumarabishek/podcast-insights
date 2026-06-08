-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "cached" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ip" TEXT;

-- CreateIndex
CREATE INDEX "Job_ip_cached_createdAt_idx" ON "Job"("ip", "cached", "createdAt");

