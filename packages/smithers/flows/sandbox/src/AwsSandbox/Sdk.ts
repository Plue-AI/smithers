/**
 * The structural slice of the AWS ECS client used by this provider.
 *
 * @since 0.1.0
 */

interface KeyValuePair {
  readonly name?: string | undefined
  readonly value?: string | undefined
}

interface ManagedAgent {
  readonly name?: string | undefined
  readonly lastStatus?: string | undefined
  readonly reason?: string | undefined
}

interface Container {
  readonly name?: string | undefined
  readonly managedAgents?: ReadonlyArray<ManagedAgent> | undefined
}

interface Tag {
  readonly key?: string | undefined
  readonly value?: string | undefined
}

interface Task {
  readonly startedBy?: string | undefined
  readonly taskDefinitionArn?: string | undefined
  readonly tags?: ReadonlyArray<Tag> | undefined
  readonly taskArn?: string | undefined
  readonly lastStatus?: string | undefined
  readonly desiredStatus?: string | undefined
  readonly enableExecuteCommand?: boolean | undefined
  readonly containers?: ReadonlyArray<Container> | undefined
}

interface Failure {
  readonly arn?: string | undefined
  readonly reason?: string | undefined
  readonly detail?: string | undefined
}

interface AwsVpcConfiguration {
  readonly subnets: Array<string>
  readonly securityGroups?: Array<string> | undefined
  readonly assignPublicIp?: "ENABLED" | "DISABLED" | undefined
}

interface RunTaskInput {
  readonly tags?: Array<Tag> | undefined
  readonly cluster: string
  readonly taskDefinition: string
  readonly count: number
  readonly enableExecuteCommand: boolean
  readonly launchType: "FARGATE"
  readonly networkConfiguration: {
    readonly awsvpcConfiguration: AwsVpcConfiguration
  }
  readonly startedBy: string
  readonly platformVersion?: string | undefined
  readonly overrides?: {
    readonly containerOverrides?:
      | Array<{
        readonly name: string
        readonly environment?: Array<KeyValuePair> | undefined
      }>
      | undefined
    readonly taskRoleArn?: string | undefined
    readonly executionRoleArn?: string | undefined
  } | undefined
}

interface RunTaskOutput {
  readonly tasks?: ReadonlyArray<Task> | undefined
  readonly failures?: ReadonlyArray<Failure> | undefined
}

interface DescribeTasksInput {
  readonly include?: Array<"TAGS"> | undefined
  readonly cluster: string
  readonly tasks: Array<string>
}

interface ListTasksInput {
  readonly cluster: string
  readonly startedBy: string
  readonly desiredStatus?: "RUNNING" | "PENDING" | "STOPPED" | undefined
  readonly nextToken?: string | undefined
}

interface ListTasksOutput {
  readonly taskArns?: ReadonlyArray<string> | undefined
  readonly nextToken?: string | undefined
}

interface DescribeTasksOutput {
  readonly tasks?: ReadonlyArray<Task> | undefined
  readonly failures?: ReadonlyArray<Failure> | undefined
}

interface StopTaskInput {
  readonly cluster: string
  readonly task: string
  readonly reason?: string | undefined
}

interface RegisterTaskDefinitionInput {
  readonly family: string
  readonly networkMode: "awsvpc"
  readonly requiresCompatibilities: Array<"FARGATE">
  readonly cpu: string
  readonly memory: string
  readonly taskRoleArn: string
  readonly executionRoleArn?: string | undefined
  readonly containerDefinitions: Array<{
    readonly name: string
    readonly image: string
    readonly essential: boolean
    readonly command: Array<string>
    readonly workingDirectory: string
    readonly linuxParameters: { readonly initProcessEnabled: boolean }
  }>
}

interface RegisterTaskDefinitionOutput {
  readonly taskDefinition?: {
    readonly taskDefinitionArn?: string | undefined
  } | undefined
}

interface ListTaskDefinitionsInput {
  readonly familyPrefix: string
  readonly status: "ACTIVE"
  readonly nextToken?: string | undefined
}

interface ListTaskDefinitionsOutput {
  readonly taskDefinitionArns?: ReadonlyArray<string> | undefined
  readonly nextToken?: string | undefined
}

interface DeregisterTaskDefinitionInput {
  readonly taskDefinition: string
}

/**
 * A configured AWS ECS aggregate client.
 *
 * The AWS SDK v3 publishes these methods on its `ECS` aggregate client. The
 * provider accepts this narrow structural view instead of importing
 * `@aws-sdk/client-ecs`, keeping the package dependency-free and browser-safe.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sdk {
  readonly runTask: (input: RunTaskInput) => Promise<RunTaskOutput>
  readonly describeTasks: (input: DescribeTasksInput) => Promise<DescribeTasksOutput>
  readonly listTasks: (input: ListTasksInput) => Promise<ListTasksOutput>
  readonly stopTask: (input: StopTaskInput) => Promise<unknown>
  readonly registerTaskDefinition: (
    input: RegisterTaskDefinitionInput
  ) => Promise<RegisterTaskDefinitionOutput>
  readonly listTaskDefinitions: (input: ListTaskDefinitionsInput) => Promise<ListTaskDefinitionsOutput>
  readonly deregisterTaskDefinition: (input: DeregisterTaskDefinitionInput) => Promise<unknown>
}
