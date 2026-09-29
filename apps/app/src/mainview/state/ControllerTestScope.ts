import { afterEach } from "bun:test"
import { createAppController } from "./AppController"
import type { AppController, AppFeatures } from "./AppController"
import { applicationIdentityFromFetch } from "./TestFixtures"

const defaultOrigin = "https://app.test"

/**
 * Call once at a test file's top level to register that file's cleanup hook.
 * A failed assertion must not leave its controller's polls, subscriptions or
 * identity listeners running in later tests. Explicit early disposal remains
 * safe because the controller's dispose contract is idempotent.
 */
export const scopedControllers = (features: AppFeatures = {}): typeof createAppController => {
  const controllers = new Set<AppController>()
  afterEach(async () => {
    const errors: unknown[] = []
    try {
      for (const controller of controllers) {
        try {
          await controller.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      controllers.clear()
    }
    if (errors.length > 0) throw new AggregateError(errors, "Controller fixture cleanup failed")
  })
  return (...args) => {
    const [store, agent, services] = args
    const pageOrigin = new URL(services?.baseUrl || defaultOrigin, defaultOrigin).origin
    const applicationIdentity = services !== undefined && "applicationIdentity" in services
      ? services.applicationIdentity
      : services?.fetchImpl === undefined
      ? undefined
      : applicationIdentityFromFetch(services.fetchImpl, pageOrigin, services.applicationTarget)
    const controller = createAppController(store, agent, {
      ...services, applicationIdentity, features: { ...features, ...services?.features }
    })
    controllers.add(controller)
    return controller
  }
}
