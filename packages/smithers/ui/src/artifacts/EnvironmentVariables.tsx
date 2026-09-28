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
 *
 * Unambiguous words (`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `WEBHOOK`, ...) match anywhere in
 * the name. `KEY` matches unless a letter follows it, so `API_KEY` and `APIKEY` mask while
 * `KEYBOARD_LAYOUT` shows. `AUTH` matches `OAUTH` and `AUTHORIZATION` but not `AUTHOR`. Words that
 * also name ordinary settings count only as a whole `_`-separated word: `PASS`, `PW`, `PWD`, `SK`,
 * `PAT`, `OTP`, `TOTP`, `PIN`, `SIGN`, `SIGNING`, `SIGNATURE`, `CERT`, `CERTIFICATE`, so `MYSQL_PWD`
 * and `TLS_CERT` mask while `PATH`, `PASSTHROUGH`, `SIGNAL_LEVEL`, and `CERTIFIED` show. `SESSION`
 * masks only as the last word or before `ID` (`SESSION_ID`), so `SESSION_TIMEOUT` shows.
 *
 * A URL name alone is not a credential: `PUBLIC_URL` shows. A URL masks by its value,
 * {@link CREDENTIAL_VALUE}.
 */
const CREDENTIAL_NAME = new RegExp(
  [
    "TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|COOKIE|DSN|SALT|HMAC|BEARER|WEBHOOK",
    "KEYS?(?![A-Z])",
    "AUTH(?!OR(?!IZ))",
    "(?:^|_)(?:PASS|PWD?|SK|PAT|T?OTP|PIN|SIGN|SIGNING|SIGNATURE|CERTS?|CERTIFICATE)(?:_|$)",
    "(?:^|_)SESSION(?:_?ID)?$",
  ].join("|"),
  "i",
);
/**
 * A value carrying a credential whatever its variable is called: a URL with `user:password@`, or a
 * URL query or connection string with a credential-named parameter (`?token=`, `;Password=`).
 */
const CREDENTIAL_VALUE = new RegExp(
  [
    "^[a-z][a-z0-9+.-]*://[^/@\\s]*:[^/@\\s]*@",
    "(?:^|[?&;\\s])[a-z0-9_-]*(?:password|passwd|pwd|secret|token|key|sig|signature|auth|credential)=",
  ].join("|"),
  "i",
);

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
  const secret = declared ?? (CREDENTIAL_NAME.test(name) || (value !== undefined && CREDENTIAL_VALUE.test(value.trim())));
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
