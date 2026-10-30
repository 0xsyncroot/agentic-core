import { reviewTime } from "@0xsyncroot/contracts";

/**
 * Review times cross the driver as text in both directions. A JS Date keeps milliseconds only, so a DATETIME(6) read into
 * one and written back as a keyset bound would skip or repeat rows that differ in the last three digits.
 */

/** The canonical review time as DATETIME(6) text; anything `reviewTime` refuses is `validation`. */
export function mysqlTime(value: string, field: string): string {
  return reviewTime(value, field).slice(0, 26).replace("T", " ");
}

/** A DATETIME(6) column read as the canonical review time, `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
export function isoColumn(column: string): string {
  return `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ')`;
}
