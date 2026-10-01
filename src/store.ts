import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** Minimal secret store so the token logic can be tested without AWS. */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  put(name: string, value: string): Promise<void>;
}

export function ssmStore(client = new SSMClient({})): SecretStore {
  return {
    async get(name) {
      try {
        const out = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
        return out.Parameter?.Value;
      } catch (err) {
        if (err instanceof ParameterNotFound) return undefined;
        throw err;
      }
    },
    async put(name, value) {
      // SecureString with the AWS-managed aws/ssm key: free, and the key policy already
      // lets this account's principals encrypt/decrypt through SSM.
      await client.send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true }));
    },
  };
}

export function paramNames(prefix = process.env.PARAM_PREFIX ?? '/oura-mcp') {
  return {
    pathSecret: `${prefix}/path-secret`,
    oauthClient: `${prefix}/oauth-client`,
    tokens: `${prefix}/tokens`,
    ingestPathSecret: `${prefix}/ingest-path-secret`,
    ingestKey: `${prefix}/ingest-key`,
  };
}
