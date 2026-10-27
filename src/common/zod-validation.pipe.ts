import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "./errors.js";

/** Validates a request body against a zod schema (use strictObject). Invalid → 400 invalid_request. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(
    private readonly schema: T,
    private readonly message: string,
  ) {}

  transform(value: unknown): z.infer<T> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new ApiError(400, "invalid_request", this.message);
    return parsed.data;
  }
}
