"""Real compiled CLI smoke: module loading and durable journal, without a model."""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ale_run.base_interface.trajectory import TrajectoryBuilder
from config import SmithersConfig
from deployer import CLI, HELPER, SmithersDeployer, _journal


class NativeCliTests(unittest.IsolatedAsyncioTestCase):
    async def test_generated_imports_execute_and_real_step_facts_parse(self):
        root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory(dir=os.environ['ALE_TEST_SCRATCH']) as directory:
            work = Path(directory)
            agent = SmithersDeployer.__new__(SmithersDeployer)
            agent.config = SmithersConfig(root=str(root))
            agent.executor = type('Executor', (), {'work_dir': str(work)})()
            agent.root, agent.cli, agent.helper = root, root / CLI, root / HELPER
            agent.node, agent.servers, agent.flows = shutil.which('node'), [], []
            original = agent._command

            async def smoke(args, workspace, env, log):
                # Keep the generated runtime imports and Task declaration. Replace only
                # the model action with a synthetic action using the REAL host sink.
                flow = workspace / 'flows/ale/flow.ts'
                source = flow.read_text()
                shutil.copyfile(Path(__file__).with_name('cli_trace.ts'), flow.parent / 'cli_trace.ts')
                fixture = './cli_trace.ts'
                source = ('import { layer as smokeLayer, smoke } from ' + repr(fixture) + ';\n' + source)
                source = source.replace('export const layer = Task.layer;', 'export const layer = smokeLayer;')
                source = source.replace('body: () => Task.call({ instruction: "smoke" })', 'body: () => smoke()')
                flow.write_text(source)
                return await original(args, workspace, env, log)

            agent._command = smoke
            result = await asyncio.wait_for(agent.launch('smoke'), timeout=90)
            # No model ran: valid route evidence must still be refused.
            self.assertEqual(result.exit_code, 0, (work / 'smithers-run.log').read_text())
            self.assertEqual(result.status, 'failed')
            self.assertIn('subscription model-route', result.error)
            events = _journal(work)
            self.assertTrue(any(tag == 'control.run.completed' for tag, _ in events))
            printed = [p['text'] for tag, p in events if tag == 'control.agent.cell-printed']
            self.assertEqual(printed, ['real native journal'])
            builder = TrajectoryBuilder(agent_name='smithers', task_path='smoke', variant_index=0)
            agent.parse_artifacts(work_dir=work, config=agent.config, run_result=result, builder=builder)
            self.assertEqual([step.message for step in builder.trajectory.steps], ['real native journal'])
            self.assertIsNone(builder.trajectory.final_metrics)


if __name__ == '__main__':
    unittest.main()
