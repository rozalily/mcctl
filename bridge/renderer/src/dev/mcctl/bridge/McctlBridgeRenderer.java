package dev.mcctl.bridge;

import java.util.ArrayList;
import java.util.List;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.map.MapFont.CharacterSprite;
import org.bukkit.map.MinecraftFont;
import org.bukkit.plugin.java.JavaPlugin;

public final class McctlBridgeRenderer extends JavaPlugin {
    private static final int MAX_CHAT_WIDTH = 240;

    @Override
    public void onEnable() {}

    @Override
    public void onDisable() {}

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] arguments) {
        if (!(sender instanceof ConsoleCommandSender)) {
            sender.sendMessage("This command is console-only.");
            return true;
        }
        if (arguments.length == 0) return true;

        StringBuilder message = new StringBuilder(arguments[0]);
        for (int index = 1; index < arguments.length; index += 1) {
            message.append(' ').append(arguments[index]);
        }
        for (String line : wrapMessage(message.toString())) {
            getServer().broadcastMessage(line);
        }
        return true;
    }

    static List<String> wrapMessage(String message) {
        List<String> lines = new ArrayList<String>();
        StringBuilder line = new StringBuilder();
        String activeColor = "§f";
        for (String word : message.split(" +")) {
            String separator = line.length() == 0 ? "" : " ";
            if (line.length() > 0 && width(line + separator + word) > MAX_CHAT_WIDTH) {
                lines.add(line.toString());
                line = new StringBuilder(activeColor);
                separator = "";
            }
            if (width(line + word) > MAX_CHAT_WIDTH) {
                for (int index = 0; index < word.length(); index += 1) {
                    char character = word.charAt(index);
                    if (character == '§' && index + 1 < word.length()) {
                        line.append(character).append(word.charAt(++index));
                        activeColor = updateColor(activeColor, word.substring(index - 1, index + 1));
                        continue;
                    }
                    if (width(line.toString()) + characterWidth(character) > MAX_CHAT_WIDTH && visibleLength(line.toString()) > 0) {
                        lines.add(line.toString());
                        line = new StringBuilder(activeColor);
                    }
                    line.append(character);
                }
            } else {
                line.append(separator).append(word);
            }
            activeColor = updateColor(activeColor, word);
        }
        if (visibleLength(line.toString()) > 0) lines.add(line.toString());
        return lines;
    }

    private static int width(String text) {
        int width = 0;
        for (int index = 0; index < text.length(); index += 1) {
            char character = text.charAt(index);
            if (character == '§' && index + 1 < text.length()) {
                index += 1;
                continue;
            }
            width += characterWidth(character);
        }
        return Math.max(0, width - 1);
    }

    private static int characterWidth(char character) {
        CharacterSprite sprite = MinecraftFont.Font.getChar(character);
        return sprite == null ? 6 : sprite.getWidth() + 1;
    }

    private static int visibleLength(String text) {
        return text.replaceAll("§.", "").length();
    }

    private static String updateColor(String current, String text) {
        for (int index = 0; index + 1 < text.length(); index += 1) {
            if (text.charAt(index) != '§') continue;
            char code = Character.toLowerCase(text.charAt(index + 1));
            if ((code >= '0' && code <= '9') || (code >= 'a' && code <= 'f')) current = "§" + code;
            if (code == 'r') current = "§f";
            index += 1;
        }
        return current;
    }
}