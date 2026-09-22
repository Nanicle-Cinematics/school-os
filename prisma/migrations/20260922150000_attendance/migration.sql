-- The register: who was in school, and on which days anybody looked.
--
-- TermResult.daysPresent/daysTotal have been typed by hand since the report
-- card existed, with a note in the schema promising a module would one day fill
-- them. This is that module.
--
-- ⚠️ TWO tables, not one, and the second is the reason the first exists.
-- AttendanceDay records that the register WAS TAKEN for a class on a date; the
-- marks hang off it. The report card's denominator is "days the register was
-- taken", and that has to be a fact the database holds rather than something
-- inferred from how many children happen to have a mark — otherwise a day the
-- teacher forgot is indistinguishable from a day everyone was absent, and the
-- school's own negligence prints as the child's attendance record.
--
-- ADDITIVE ONLY: two new tables, one new enum. Nothing existing is altered, so
-- this deploys BEFORE the merge (see .github/workflows/migrate.yml).
CREATE TYPE "AttendanceMark" AS ENUM ('PRESENT', 'LATE', 'EXCUSED', 'ABSENT');

CREATE TABLE "AttendanceDay" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "classGroupId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "takenByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceDay_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttendanceEntry" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "attendanceDayId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "mark" "AttendanceMark" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttendanceDay_schoolId_termId_classGroupId_idx" ON "AttendanceDay"("schoolId", "termId", "classGroupId");
-- One register per class per day. Re-marking corrects it rather than opening a
-- second one, which is what makes an afternoon correction safe.
CREATE UNIQUE INDEX "AttendanceDay_classGroupId_date_key" ON "AttendanceDay"("classGroupId", "date");

CREATE INDEX "AttendanceEntry_schoolId_studentId_idx" ON "AttendanceEntry"("schoolId", "studentId");
CREATE UNIQUE INDEX "AttendanceEntry_attendanceDayId_studentId_key" ON "AttendanceEntry"("attendanceDayId", "studentId");

ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_classGroupId_fkey" FOREIGN KEY ("classGroupId") REFERENCES "ClassGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull, not Cascade: a teacher leaving the school must not delete the days
-- they marked. The register outlives the person who took it.
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_takenByStaffId_fkey" FOREIGN KEY ("takenByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AttendanceEntry" ADD CONSTRAINT "AttendanceEntry_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceEntry" ADD CONSTRAINT "AttendanceEntry_attendanceDayId_fkey" FOREIGN KEY ("attendanceDayId") REFERENCES "AttendanceDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceEntry" ADD CONSTRAINT "AttendanceEntry_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
