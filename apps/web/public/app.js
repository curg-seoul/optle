const $ = (id) => document.getElementById(id);

const SAMPLE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Rewards {
    address public owner;
    uint256[] public amounts;
    uint256 public total;

    constructor() {
        owner = msg.sender;
    }

    function add(uint256 amount) public {
        require(amount > 0, "amount must be greater than zero");
        amounts.push(amount);
    }

    function computeTotal() public returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            sum = sum + amounts[i];
        }
        total = sum;
        return sum;
    }

    function count() public view returns (uint256) {
        return amounts.length;
    }
}
`;

$("sample").addEventListener("click", () => {
  $("code").value = SAMPLE;
});

$("optimize").addEventListener("click", async () => {
  const code = $("code").value.trim();
  if (!code) {
    alert("Paste a contract first (or click “Load sample”).");
    return;
  }

  const btn = $("optimize");
  btn.disabled = true;
  btn.textContent = "Optimizing…";

  try {
    const res = await fetch("/api/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    render(await res.json());
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Optimize gas →";
  }
});

$("copy").addEventListener("click", () => {
  navigator.clipboard.writeText($("optimized").textContent);
  $("copy").textContent = "Copied!";
  setTimeout(() => ($("copy").textContent = "Copy"), 1200);
});

function render(data) {
  $("empty").hidden = true;
  $("result").hidden = false;
  $("copy").hidden = false;

  $("gasBefore").textContent = data.gasBefore.toLocaleString();
  $("gasAfter").textContent = data.gasAfter.toLocaleString();
  $("saved").textContent = `−${data.savedPct}%`;

  const list = $("changes");
  list.innerHTML = "";
  if (data.changes.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No optimization opportunities detected.";
    list.appendChild(li);
  }
  for (const c of data.changes) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = `tag ${c.kind}`;
    tag.textContent = c.kind;
    const desc = document.createElement("span");
    desc.textContent = c.description;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `×${c.count}`;
    li.append(tag, desc, count);
    list.appendChild(li);
  }

  $("optimized").textContent = data.optimized;
}
