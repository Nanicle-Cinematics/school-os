-- Mock examinations for the final-year (BECE candidate) class: a MockExam per
-- sitting ("Mock 1", "Mock 2") and a MockScore per pupil per subject.
--
-- ADDITIVE: two new tables, nothing existing is touched. Migrates BEFORE the
-- merge. ⚠️ Both are TENANT tables (schoolId), so production also needs the
-- `rls` action of migrate.yml straight after `deploy` — a new table arrives with
-- no row security at all (see CLAUDE.md, AssessmentTemplate and SchoolAsset).

-- CreateTable
CREATE TABLE "MockExam" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sittingDate" TIMESTAMP(3),
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockExam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockScore" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "mockExamId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "rawScore" DECIMAL(5,2),
    "isAbsent" BOOLEAN NOT NULL DEFAULT false,
    "enteredByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MockExam_schoolId_idx" ON "MockExam"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "MockExam_schoolId_academicYearId_levelId_title_key" ON "MockExam"("schoolId", "academicYearId", "levelId", "title");

-- CreateIndex
CREATE INDEX "MockScore_schoolId_idx" ON "MockScore"("schoolId");

-- CreateIndex
CREATE INDEX "MockScore_mockExamId_subjectId_idx" ON "MockScore"("mockExamId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "MockScore_mockExamId_studentId_subjectId_key" ON "MockScore"("mockExamId", "studentId", "subjectId");

-- AddForeignKey
ALTER TABLE "MockExam" ADD CONSTRAINT "MockExam_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MockExam" ADD CONSTRAINT "MockExam_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MockExam" ADD CONSTRAINT "MockExam_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "Level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MockScore" ADD CONSTRAINT "MockScore_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MockScore" ADD CONSTRAINT "MockScore_mockExamId_fkey" FOREIGN KEY ("mockExamId") REFERENCES "MockExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MockScore" ADD CONSTRAINT "MockScore_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MockScore" ADD CONSTRAINT "MockScore_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
