-- CreateEnum
CREATE TYPE "SkillGrade" AS ENUM ('A', 'B', 'C');

-- CreateTable
CREATE TABLE "SubjectSkill" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubjectSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillRating" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "score" DECIMAL(5,2),
    "grade" "SkillGrade",
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubjectSkill_schoolId_idx" ON "SubjectSkill"("schoolId");

-- CreateIndex
CREATE INDEX "SubjectSkill_subjectId_idx" ON "SubjectSkill"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectSkill_levelId_subjectId_name_key" ON "SubjectSkill"("levelId", "subjectId", "name");

-- CreateIndex
CREATE INDEX "SkillRating_schoolId_termId_idx" ON "SkillRating"("schoolId", "termId");

-- CreateIndex
CREATE INDEX "SkillRating_studentId_idx" ON "SkillRating"("studentId");

-- CreateIndex
CREATE INDEX "SkillRating_skillId_idx" ON "SkillRating"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillRating_termId_studentId_skillId_key" ON "SkillRating"("termId", "studentId", "skillId");

-- AddForeignKey
ALTER TABLE "SubjectSkill" ADD CONSTRAINT "SubjectSkill_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectSkill" ADD CONSTRAINT "SubjectSkill_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "Level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectSkill" ADD CONSTRAINT "SubjectSkill_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRating" ADD CONSTRAINT "SkillRating_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRating" ADD CONSTRAINT "SkillRating_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRating" ADD CONSTRAINT "SkillRating_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRating" ADD CONSTRAINT "SkillRating_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "SubjectSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

