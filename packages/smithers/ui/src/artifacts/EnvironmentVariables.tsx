/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { SecretField } from "./SecretField";

export type EnvironmentVariableModel = {
  name: string;
  value?: string;
  /** Masks the value. Unset, a credential-shaped name masks it; pass `false` to show it. */
  secret?: boolean;
};

/**
 * Names that usually hold a credential: masked unless the caller passes `secret={false}`.
 * `URL`/`URI`/`DSN` cover connection strings (`DATABASE_URL`), `PASS` covers `PASSWORD`,
 * `PASSWD`, and `PASSPHRASE`. Short abbreviations (`PW`, `PWD`, `SK`, `PAT`, `OTP`, `TOTP`, `PIN`)
 * count only as a whole `_`-separated word, so `MYSQL_PWD` and `GH_PAT` mask while `PATH` shows.
 * The match is a heuristic: a harmless name that contains one of these words (`AUTHOR`) is masked too.
 */
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|PRIVATE|COOKIE|SESSION|DSN|URL|URI|SALT|CERT|SIGN|HMAC|BEARER|(?:^|_)(?:PWD?|SK|PAT|T?OTP|PIN)(?:_|$)/i;
/** A URL carrying `user:password@` credentials, whatever its variable is called. */
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i;

export type EnvironmentVariablesProps = Omit<ComponentProps<"div">, "children"> & (
  | { variables: readonly EnvironmentVariableModel[]; children?: never }
  | { children: ReactNode; variables?: never }
);

/** Name/value rows for a process environment; secrets go through SecretField. */
export function EnvironmentVariables(props: EnvironmentVariablesProps) {
  useInjectUiCss();
  const p = props as { className?: string; variables?: readonly EnvironmentVariableModel[]; children?: ReactNode } & ComponentProps<"div">;
  const { className, variables, children, ...divProps } = p;
  return (
    <div data-slot="environment-variables" className={cn("sui-envvars", className)} {...divProps}>
      {variables
        ? variables.map((variable) => (
            <EnvironmentVariable
              key={variable.name}
              name={variable.name}
              value={variable.value}
              secret={variable.secret}
            />
          ))
        : children}
    </div>
  );
}

export type EnvironmentVariableProps = Omit<ComponentProps<"div">, "children"> & {
  name: string;
  value?: string;
  /** Masks the value. Unset, a credential-shaped name masks it; pass `false` to show it. */
  secret?: boolean;
};

export function EnvironmentVariable({ name, value, secret: declared, className, ...props }: EnvironmentVariableProps) {
  useInjectUiCss();
  const secret = declared ?? (CREDENTIAL_NAME.test(name) || (value !== undefined && CREDENTIAL_URL.test(value.trim())));
  return (
    <div data-slot="environment-variable" data-secret={secret ? "true" : "false"} className={cn("sui-envvar", className)} {...props}>
      <span className="sui-envvar-name">{name}</span>
      {value === undefined ? (
        <span className="sui-envvar-value sui-envvar-unset">—</span>
      ) : secret ? (
        <SecretField value={value} label={name} />
      ) : (
        <span className="sui-envvar-value">{value}</span>
      )}
    </div>
  );
}
