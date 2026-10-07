@file:OptIn(ExperimentalMaterial3Api::class)

package app.financas.ui

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilledIconToggleButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** Material 3; usa as cores do papel de parede (Material You) no Android 12+. */
@Composable
fun AppTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val ctx = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        dark -> darkColorScheme()
        else -> lightColorScheme()
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

val Positive @Composable get() = if (isSystemInDarkTheme()) Color(0xFF6DD58C) else Color(0xFF146C2E)
val Negative @Composable get() = MaterialTheme.colorScheme.error

@Composable
fun MonthBar(month: String, onShift: (Int) -> Unit, label: String = monthLabel(month)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton({ onShift(-1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Mês anterior") }
        Text(label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 4.dp))
        IconButton({ onShift(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Próximo mês") }
    }
}

@Composable
fun SectionCard(title: String? = null, modifier: Modifier = Modifier, action: @Composable (() -> Unit)? = null, content: @Composable () -> Unit) {
    Card(modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
        Column(Modifier.padding(16.dp)) {
            if (title != null) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    action?.invoke()
                }
            }
            content()
        }
    }
}

@Composable
fun Kpi(label: String, value: Long, sub: String? = null, color: Color = Color.Unspecified, modifier: Modifier = Modifier) {
    Card(modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
        Column(Modifier.padding(14.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(money(value), style = MaterialTheme.typography.titleLarge, color = color)
            if (sub != null) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun Letter(name: String?, color: String?) {
    Box(Modifier.size(40.dp).background(hexColor(color), CircleShape), contentAlignment = Alignment.Center) {
        Text((name ?: "?").take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun Tag(text: String, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Surface(shape = MaterialTheme.shapes.extraSmall, color = color.copy(alpha = .14f)) {
        Text(text, Modifier.padding(horizontal = 6.dp, vertical = 1.dp), style = MaterialTheme.typography.labelSmall, color = color)
    }
}

/** Botão circular de "pago". */
@Composable
fun PaidToggle(paid: Boolean, onToggle: (() -> Unit)?) {
    FilledIconToggleButton(
        checked = paid, onCheckedChange = { onToggle?.invoke() }, enabled = onToggle != null,
        modifier = Modifier.size(36.dp).border(1.dp, if (paid) Color.Transparent else MaterialTheme.colorScheme.outline, CircleShape),
        colors = IconButtonDefaults.filledIconToggleButtonColors(
            containerColor = Color.Transparent, checkedContainerColor = Positive,
            disabledContainerColor = Color.Transparent,
        ),
    ) { Icon(Icons.Filled.Check, if (paid) "Pago" else "Marcar como pago", Modifier.size(18.dp)) }
}

@Composable
fun <T> Dropdown(label: String, options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(open, { open = it }, modifier) {
        OutlinedTextField(
            value = options.firstOrNull { it.first == selected }?.second ?: "", onValueChange = {}, readOnly = true,
            label = { Text(label) }, trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(), singleLine = true,
        )
        ExposedDropdownMenu(open, { open = false }) {
            options.forEach { (v, l) -> DropdownMenuItem(text = { Text(l) }, onClick = { onSelect(v); open = false }) }
        }
    }
}

@Composable
fun DateField(label: String, value: LocalDate?, onChange: (LocalDate?) -> Unit, modifier: Modifier = Modifier, clearable: Boolean = false) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        OutlinedTextField(
            value = value?.let(::dmy) ?: "", onValueChange = {}, readOnly = true, label = { Text(label) },
            trailingIcon = {
                if (clearable && value != null) IconButton({ onChange(null) }) { Icon(Icons.Outlined.Close, "Limpar") }
                else Icon(Icons.Outlined.CalendarMonth, null)
            },
            modifier = Modifier.fillMaxWidth(), singleLine = true,
        )
        Box(Modifier.matchParentSize().padding(end = if (clearable && value != null) 48.dp else 0.dp).clickable { open = true })
    }
    if (open) {
        val st = rememberDatePickerState(initialSelectedDateMillis = (value ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton({
                    st.selectedDateMillis?.let { onChange(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                    open = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton({ open = false }) { Text("Cancelar") } },
        ) { DatePicker(st) }
    }
}

@Composable
fun MoneyField(label: String, value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) =
    OutlinedTextField(value, onChange, modifier.fillMaxWidth(), label = { Text(label) }, prefix = { Text("R$ ") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true)

@Composable
fun NumberField(label: String, value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier, placeholder: String? = null) =
    OutlinedTextField(value, { v -> onChange(v.filter(Char::isDigit).take(3)) }, modifier.fillMaxWidth(), label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true)

@Composable
fun <T> Segmented(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        options.forEachIndexed { i, (v, l) ->
            SegmentedButton(selected == v, { onSelect(v) }, SegmentedButtonDefaults.itemShape(i, options.size)) { Text(l, maxLines = 1) }
        }
    }
}

@Composable
fun ColorPicker(selected: String, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        PALETTE.take(8).forEach { c ->
            Box(
                Modifier.size(30.dp).background(hexColor(c), CircleShape)
                    .border(if (c.equals(selected, true)) 3.dp else 0.dp, MaterialTheme.colorScheme.onSurface, CircleShape)
                    .clickable { onSelect(c) },
            )
        }
    }
}
