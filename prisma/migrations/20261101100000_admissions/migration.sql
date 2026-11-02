-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('APPLIED', 'TESTING', 'WAITLISTED', 'OFFERED', 'ACCEPTED', 'ADMITTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApplicationSource" AS ENUM ('OFFICE', 'ONLINE');

-- AlterTable
ALTER TABLE "SchoolSettings" ADD COLUMN     "applicationsNote" TEXT,
ADD COLUMN     "applicationsOpen" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "source" "ApplicationSource" NOT NULL DEFAULT 'OFFICE',
    "status" "ApplicationStatus" NOT NULL DEFAULT 'APPLIED',
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "previousSchool" TEXT,
    "notes" TEXT,
    "guardianName" TEXT NOT NULL,
    "guardianPhone" TEXT NOT NULL,
    "guardianEmail" TEXT,
    "guardianRelationship" "GuardianRelationship" NOT NULL DEFAULT 'GUARDIAN',
    "levelId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "testedOn" TIMESTAMP(3),
    "testScore" DECIMAL(5,2),
    "testNotes" TEXT,
    "offerExpiresOn" TIMESTAMP(3),
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "studentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Application_studentId_key" ON "Application"("studentId");

-- CreateIndex
CREATE INDEX "Application_schoolId_status_idx" ON "Application"("schoolId", "status");

-- CreateIndex
CREATE INDEX "Application_schoolId_levelId_academicYearId_idx" ON "Application"("schoolId", "levelId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_schoolId_reference_key" ON "Application"("schoolId", "reference");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "Level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;
