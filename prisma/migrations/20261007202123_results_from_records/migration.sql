-- CreateEnum
CREATE TYPE "ResultSource" AS ENUM ('COMPUTED', 'RECORDS');

-- AlterTable
ALTER TABLE "SubjectResult" ADD COLUMN     "source" "ResultSource" NOT NULL DEFAULT 'COMPUTED';

-- AlterTable
ALTER TABLE "TermResult" ADD COLUMN     "source" "ResultSource" NOT NULL DEFAULT 'COMPUTED';
