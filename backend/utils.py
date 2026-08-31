from datetime import datetime
import inspect
import os

def debug_print(contents):
    # Get the caller's frame
    frame = inspect.currentframe().f_back
    
    # Get file name (just the base name, not full path)
    file_name = os.path.basename(frame.f_globals.get("__file__", "unknown"))
    
    # Get function name
    function_name = frame.f_code.co_name
    
    now = datetime.now()
    date_time_info = now.strftime("%H:%M:%S.%f")[:-3]
    if function_name == "<module>":
        function_name = "global"
    print(f"\n[{date_time_info}] [{file_name}] [{function_name}] DEBUG: {contents}")

import re


def diff_applier(initial_code: str, diffs) -> str:
    """Apply structured search/replace diffs returned by the agent.

    The response schema uses a list of objects with ``search`` and ``replace``
    fields. The legacy textual SEARCH/REPLACE format is retained as a fallback.
    """
    if not diffs or diffs == "NA":
        return initial_code

    if isinstance(diffs, list):
        blocks = diffs
    elif isinstance(diffs, dict) and "search" in diffs and "replace" in diffs:
        blocks = [diffs]
    elif isinstance(diffs, str):
        if diffs.strip().upper() == "NA":
            return initial_code

        # Accept the legacy format, optionally surrounded by Markdown fences
        # or a unified-diff header.
        pattern = re.compile(
            r"<<<<<<< SEARCH\r?\n(.*?)\r?\n=======\r?\n(.*?)\r?\n>>>>>>> REPLACE",
            re.DOTALL,
        )
        blocks = [
            {"search": match.group(1), "replace": match.group(2)}
            for match in pattern.finditer(diffs)
        ]
        if not blocks:
            raise ValueError("No valid search/replace diffs found.")
    else:
        raise TypeError("diffs must be a list, mapping, or string.")

    code = initial_code

    for block in blocks:
        search_text = block.search if hasattr(block, "search") else block["search"]
        replace_text = block.replace if hasattr(block, "replace") else block["replace"]

        occurrences = code.count(search_text)

        if occurrences == 0:
            raise ValueError(
                f"Could not find SEARCH block in workspace:\n{search_text[:200]}"
            )

        if occurrences > 1:
            raise ValueError(
                f"SEARCH block matched {occurrences} locations. "
                "Refusing to apply ambiguous patch."
            )

        code = code.replace(search_text, replace_text, 1)

    return code
