import sql from "mssql";
import type { ConnectionPool, Request, Transaction } from "mssql";

const { BigInt: SqlBigInt, DateTime2, Int, MAX, NVarChar } = sql;

export type SqlScope = ConnectionPool | Transaction;

export function request(scope: SqlScope): Request { return scope.request(); }
export function text(input: Request, name: string, value: string | null, length = 191): Request {
  return input.input(name, NVarChar(length), value);
}
export function longText(input: Request, name: string, value: string | null): Request {
  return input.input(name, NVarChar(MAX), value);
}
export function integer(input: Request, name: string, value: number): Request {
  return input.input(name, Int, value);
}
export function bigInteger(input: Request, name: string, value: string | number): Request {
  return input.input(name, SqlBigInt, value);
}
export function dateTime(input: Request, name: string, value: Date): Request {
  return input.input(name, DateTime2(6), value);
}
