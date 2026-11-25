package com.saiexpress.payparking;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Indian plate format rules. Mirrors src/engine.ts (isSupportedPlateFormat, fixOcr) and src/plate-reading.ts. */
final class PlateRules {
    private PlateRules() {}

    static final Set<String> STATES = new HashSet<>(Arrays.asList(
        "AN AP AR AS BR CH CG DD DL DN GA GJ HR HP JK JH KA KL LA LD MP MH MN ML MZ NL OD OR PY PB RJ SK TN TS TG TR UP UK UA WB".split(" ")));

    private static final Pattern STANDARD = Pattern.compile("^([A-Z]{2})(?:0[1-9]|[1-9]\\d?)[A-Z]{0,3}\\d{4}$");
    private static final Pattern BHARAT = Pattern.compile("^\\d{2}BH\\d{4}[A-HJ-NP-Z]{1,2}$");
    private static final Pattern TEMPORARY = Pattern.compile("^T(?:0[1-9]|1[0-2])\\d{2}([A-Z]{2})\\d{4}[A-HJ-NP-Z]{1,2}$");

    static String norm(String s) {
        return s.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    static boolean valid(String plate) {
        Matcher m = STANDARD.matcher(plate);
        if (m.matches() && STATES.contains(m.group(1))) return true;
        if (BHARAT.matcher(plate).matches()) return true;
        m = TEMPORARY.matcher(plate);
        return m.matches() && STATES.contains(m.group(1));
    }

    private static final Map<Character, Character> TO_LETTER = new HashMap<>();
    private static final Map<Character, Character> TO_DIGIT = new HashMap<>();
    static {
        TO_LETTER.put('0', 'O'); TO_LETTER.put('1', 'I'); TO_LETTER.put('5', 'S'); TO_LETTER.put('8', 'B'); TO_LETTER.put('2', 'Z');
        TO_DIGIT.put('O', '0'); TO_DIGIT.put('I', '1'); TO_DIGIT.put('S', '5'); TO_DIGIT.put('B', '8'); TO_DIGIT.put('Z', '2'); TO_DIGIT.put('D', '0'); TO_DIGIT.put('Q', '0');
    }

    /** Letter/digit look-alikes by position: state letters first, district digits next, last four are digits. */
    static String fixOcr(String p) {
        if (p.length() < 6) return p;
        char[] a = p.toCharArray();
        for (int i = 0; i < 2; i++) a[i] = TO_LETTER.getOrDefault(a[i], a[i]);
        for (int i = 2; i < 4; i++) a[i] = TO_DIGIT.getOrDefault(a[i], a[i]);
        for (int i = a.length - 4; i < a.length; i++) a[i] = TO_DIGIT.getOrDefault(a[i], a[i]);
        return new String(a);
    }

    /** The plate exactly as read (only spaces and the IND mark removed), or null if that is not a valid plate. */
    static String directFromLines(List<String> rawLines) {
        List<String> lines = new ArrayList<>();
        for (String raw : rawLines) {
            String line = norm(raw.toUpperCase(Locale.ROOT).replaceFirst("^\\s*IND(\\s+|$)", ""));
            if (!line.isEmpty()) lines.add(line);
        }
        List<String> possible = new ArrayList<>(lines);
        for (int i = 0; i + 1 < lines.size(); i++) possible.add(lines.get(i) + lines.get(i + 1));
        for (String p : possible) if (valid(p)) return p;
        return null;
    }

    /** Lines of text from one block (top to bottom). Returns a valid plate, or null. */
    static String fromLines(List<String> rawLines) {
        List<String> lines = new ArrayList<>();
        for (String raw : rawLines) {
            String line = norm(raw.toUpperCase(Locale.ROOT).replaceFirst("^\\s*IND(\\s+|$)", ""));
            if (!line.isEmpty()) lines.add(line);
        }
        List<String> possible = new ArrayList<>(lines);
        for (int i = 0; i + 1 < lines.size(); i++) possible.add(lines.get(i) + lines.get(i + 1)); // two-line plates
        for (String p : possible) if (valid(p)) return p;
        List<String> more = new ArrayList<>();
        for (String p : possible) {
            more.add(p.replaceFirst("^[1IJL]", ""));
            more.add(p.replaceFirst("[1IJL]$", ""));
            more.add(p.replaceFirst("^[1IJL]", "").replaceFirst("[1IJL]$", ""));
            more.add(p.replaceFirst("O0", "0"));
            more.add(p.replaceFirst("0O", "0"));
        }
        for (String p : more) if (valid(p)) return p;
        for (String p : possible) { String f = fixOcr(p); if (valid(f)) return f; }
        for (String p : more) { String f = fixOcr(p); if (valid(f)) return f; }
        return null;
    }
}
