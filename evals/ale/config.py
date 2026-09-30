"""ALE config; credentials remain in the subscription account pool."""
from dataclasses import dataclass
from typing import ClassVar


@dataclass
class SmithersConfig:
    name: ClassVar[str] = "smithers"
    root: str = ""
    account_pool_url: str = ""
    model: str = "openai/gpt-6-sol"
    reasoning_effort: str = "max"

    def __post_init__(self):
        if self.model != "openai/gpt-6-sol" or self.reasoning_effort != "max":
            raise ValueError("ALE comparison requires openai/gpt-6-sol with max effort")
