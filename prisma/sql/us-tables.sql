-- CreateTable
CREATE TABLE "UsEvaluation" (
    "usEvaluationId" TEXT NOT NULL,
    "animalId" TEXT NOT NULL,
    "id17" TEXT NOT NULL,
    "sourceFamily" TEXT NOT NULL,
    "runKind" TEXT NOT NULL,
    "roundCode" TEXT,
    "periodKey" TEXT NOT NULL,
    "evaluationDate" TIMESTAMP(3) NOT NULL,
    "evalBreed" TEXT,
    "isPtaMilk" BOOLEAN,
    "isPtaCt" BOOLEAN,
    "isGraduation" BOOLEAN NOT NULL DEFAULT false,
    "blendCode" TEXT,
    "heterosis" DOUBLE PRECISION,
    "naabCode" TEXT,
    "sire17" TEXT,
    "dam17" TEXT,
    "genInb" DOUBLE PRECISION,
    "pedInb" DOUBLE PRECISION,
    "genFutInb" DOUBLE PRECISION,
    "expFutInb" DOUBLE PRECISION,
    "chip" TEXT,
    "requesterId" TEXT,
    "dateReceived" TIMESTAMP(3),
    "current" TEXT,
    "gptaJson" TEXT,
    "relJson" TEXT,
    "gsonsJson" TEXT,
    "dgvJson" TEXT,
    "paJson" TEXT,
    "haplotypesJson" TEXT,
    "nmDollar" DOUBLE PRECISION,
    "cmDollar" DOUBLE PRECISION,
    "fmDollar" DOUBLE PRECISION,
    "gmDollar" DOUBLE PRECISION,
    "milk" DOUBLE PRECISION,
    "fat" DOUBLE PRECISION,
    "pro" DOUBLE PRECISION,
    "fatPct" DOUBLE PRECISION,
    "proPct" DOUBLE PRECISION,
    "pl" DOUBLE PRECISION,
    "scs" DOUBLE PRECISION,
    "dpr" DOUBLE PRECISION,
    "ccr" DOUBLE PRECISION,
    "ptat" DOUBLE PRECISION,
    "rpa" DOUBLE PRECISION,
    "liv" DOUBLE PRECISION,
    "udc" DOUBLE PRECISION,
    "flc" DOUBLE PRECISION,
    "tpi" INTEGER,
    "tpiFormulaVersion" TEXT,
    "tpiConfidence" TEXT,
    "jpi" INTEGER,
    "jpiFormulaVersion" TEXT,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "sourceFile" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'approved',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsEvaluation_pkey" PRIMARY KEY ("usEvaluationId")
);

-- CreateTable
CREATE TABLE "UsAiStatus" (
    "id" TEXT NOT NULL,
    "animalId" TEXT,
    "id17" TEXT NOT NULL,
    "roundCode" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsAiStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsEvaluation_id17_idx" ON "UsEvaluation"("id17");

-- CreateIndex
CREATE INDEX "UsEvaluation_roundCode_runKind_idx" ON "UsEvaluation"("roundCode", "runKind");

-- CreateIndex
CREATE INDEX "UsEvaluation_isPreferred_tpi_idx" ON "UsEvaluation"("isPreferred", "tpi");

-- CreateIndex
CREATE INDEX "UsEvaluation_isPreferred_nmDollar_idx" ON "UsEvaluation"("isPreferred", "nmDollar");

-- CreateIndex
CREATE INDEX "UsEvaluation_isPreferred_ptat_idx" ON "UsEvaluation"("isPreferred", "ptat");

-- CreateIndex
CREATE INDEX "UsEvaluation_isPreferred_jpi_idx" ON "UsEvaluation"("isPreferred", "jpi");

-- CreateIndex
CREATE INDEX "UsEvaluation_animalId_evaluationDate_idx" ON "UsEvaluation"("animalId", "evaluationDate");

-- CreateIndex
CREATE UNIQUE INDEX "UsEvaluation_animalId_periodKey_sourceFamily_key" ON "UsEvaluation"("animalId", "periodKey", "sourceFamily");

-- CreateIndex
CREATE INDEX "UsAiStatus_animalId_idx" ON "UsAiStatus"("animalId");

-- CreateIndex
CREATE INDEX "UsAiStatus_roundCode_code_idx" ON "UsAiStatus"("roundCode", "code");

-- CreateIndex
CREATE UNIQUE INDEX "UsAiStatus_id17_roundCode_key" ON "UsAiStatus"("id17", "roundCode");

-- AddForeignKey
ALTER TABLE "UsEvaluation" ADD CONSTRAINT "UsEvaluation_animalId_fkey" FOREIGN KEY ("animalId") REFERENCES "Animal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsAiStatus" ADD CONSTRAINT "UsAiStatus_animalId_fkey" FOREIGN KEY ("animalId") REFERENCES "Animal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

